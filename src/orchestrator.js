'use strict';
// Bộ điều phối thảo luận nhiều vòng. Không phụ thuộc nhà cung cấp nào: chỉ làm việc qua giao diện adapter.
const { EventEmitter } = require('node:events');
const { newId } = require('./store');
const ctx = require('./context');
const { bad, notFound, conflict, limit, parseMaxRounds } = require('./errors');

const HARD_MAX_ROUNDS = 100;
const ACTIVE = ['running', 'stopping', 'synthesizing'];

const DEFAULT_LIMITS = {
  maxConcurrentSessions: 2,
  callTimeoutSec: 180,
  replyWords: '60–100',
  maxOutputTokens: 400,
  synthesisMaxOutputTokens: 900,
  recentMessages: 8,
  recentChars: 4000,
  pinnedChars: 3000,
  olderRoundsChars: 2500,
  summaryThresholdChars: 12000,
  synthesisOrder: ['claude', 'chatgpt', 'gemini'],
};

class Orchestrator extends EventEmitter {
  constructor(store, adapters, limits) {
    super();
    this.store = store;
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
    this.limits = Object.assign({}, DEFAULT_LIMITS, limits || {});
    this.runtime = new Map(); // sessionId -> { stopRequested, synthRequested, calls: Map(callId -> {controller, messageId}) }
    this.loops = new Map(); // sessionId -> Promise của vòng lặp, dùng cho kiểm thử
  }

  // ---------- Trạng thái AI ----------
  agentInfo(a) {
    const conf = a.isConfigured();
    const st = this.store.data.agentState[a.id] || {};
    let status;
    let detail = conf.detail;
    if (!conf.ok) status = 'not_connected';
    else if (st.error) { status = 'error'; detail = st.error; }
    else if (st.connectedAt) status = 'connected';
    else status = 'unverified';
    return {
      id: a.id, name: a.name, type: a.type, status, detail,
      capabilities: a.capabilities, costSource: a.costSource,
      simulated: a.type === 'mock',
      lastOkAt: st.connectedAt || null,
    };
  }

  agents() { return [...this.adapters.values()].map((a) => this.agentInfo(a)); }

  usable(id) {
    const a = this.adapters.get(id);
    if (!a) return false;
    const s = this.agentInfo(a).status;
    return s === 'connected' || s === 'unverified';
  }

  setAgentState(id, patch) {
    const cur = this.store.data.agentState[id] || {};
    this.store.data.agentState[id] = Object.assign(cur, patch);
    this.store.save();
    this.emit('event', { type: 'agents', payload: this.agents() });
  }

  // Một lượt gọi ngắn để xác minh kết nối thật. Chỉ chạy khi người dùng bấm.
  async testAgent(id) {
    const a = this.adapters.get(id);
    if (!a) throw notFound('agent');
    const conf = a.isConfigured();
    if (!conf.ok) return this.agentInfo(a);
    this.setAgentState(id, { error: null });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.callTimeoutSec * 1000);
    try {
      await a.call({ system: 'Trả lời đúng một từ: OK', prompt: 'Kiểm tra kết nối.', maxOutputTokens: 20, signal: controller.signal });
      this.setAgentState(id, { connectedAt: new Date().toISOString(), error: null });
    } catch (e) {
      this.setAgentState(id, { error: `${e.code || 'error'}: ${e.message}`, connectedAt: null });
    } finally {
      clearTimeout(timer);
    }
    return this.agentInfo(a);
  }

  // ---------- Phiên ----------
  publicSession(s) {
    if (!s) return null;
    return {
      id: s.id, conversationId: s.conversationId, requestId: s.requestId, source: s.source,
      status: s.status, round: s.round, maxRounds: s.maxRounds, participants: s.participants,
      calls: s.calls, stopReason: s.stopReason || null, synthesisMessageId: s.synthesisMessageId || null,
      createdAt: s.createdAt, endedAt: s.endedAt || null, version: s.version || 0,
    };
  }

  activeSessions() { return this.store.data.sessions.filter((s) => ACTIVE.includes(s.status)); }

  // Phiên đang "dừng" không còn tạo lượt gọi mới nên không tính vào giới hạn đồng thời.
  busyCount() { return this.store.data.sessions.filter((s) => s.status === 'running' || s.status === 'synthesizing').length; }

  startSession({ conversationId, text, participants, maxRounds, source = 'ui', apiKeyId = null, requestId = null, supersede = true }) {
    const conv = this.store.conversation(conversationId);
    if (!conv) throw notFound('cuộc trò chuyện');
    text = String(text || '').trim();
    if (!text) throw bad('Tin nhắn trống');
    if (text.length > 20000) throw bad('Tin nhắn quá dài (tối đa 20.000 ký tự)');
    const rounds = parseMaxRounds(maxRounds ?? conv.settings.maxRounds ?? 3);

    let wanted = Array.isArray(participants) && participants.length ? participants : [...this.adapters.keys()];
    const unknown = wanted.filter((id) => !this.adapters.has(id));
    if (unknown.length) throw bad(`Không có AI/agent: ${unknown.join(', ')}`);
    wanted = [...new Set(wanted)];
    const usable = wanted.filter((id) => this.usable(id));
    if (!usable.length) throw bad('Không có AI nào trong danh sách đã chọn đang kết nối');

    // Tin mới trong lúc đang thảo luận: dừng phiên cũ của cùng cuộc trò chuyện.
    const running = this.activeSessions().filter((s) => s.conversationId === conversationId);
    if (running.length && !supersede) throw conflict('Cuộc trò chuyện đang có phiên chạy');
    for (const s of running) this.stop(s.id, 'Đã thay bằng tin nhắn mới');

    if (this.busyCount() >= this.limits.maxConcurrentSessions) {
      throw limit(`Đã đạt giới hạn ${this.limits.maxConcurrentSessions} phiên chạy đồng thời`);
    }

    const now = new Date().toISOString();
    const session = {
      id: newId('ses'), conversationId, requestId: requestId || newId('req'), source, apiKeyId,
      status: 'running', round: 0, maxRounds: rounds, participants: usable,
      calls: { total: 0, byAgent: Object.fromEntries(usable.map((id) => [id, 0])) },
      createdAt: now,
    };
    this.store.data.sessions.push(session);
    conv.settings.maxRounds = rounds;
    conv.settings.participants = wanted;
    const userMsg = this.store.addMessage({ conversationId, sessionId: session.id, role: 'user', content: text, round: 0 });
    this.emit('event', { conversationId, type: 'message', payload: userMsg });
    this.emitSession(session);
    this.launch(session);
    return session;
  }

  launch(session) {
    this.runtime.set(session.id, { stopRequested: false, synthRequested: false, calls: new Map() });
    const p = this.loop(session).catch((e) => {
      console.error('[điều phối] lỗi không mong đợi:', e && e.message);
      this.finish(session, 'error', 'Lỗi nội bộ của bộ điều phối');
    });
    this.loops.set(session.id, p);
    return p;
  }

  emitSession(s) {
    s.version = (s.version || 0) + 1; // giao diện chỉ nhận trạng thái mới hơn
    this.store.save();
    this.emit('event', { conversationId: s.conversationId, type: 'session', payload: this.publicSession(s) });
  }

  setMaxRounds(sessionId, value) {
    const s = this.store.session(sessionId);
    if (!s) throw notFound('phiên');
    const n = parseMaxRounds(value);
    s.maxRounds = n;
    const conv = this.store.conversation(s.conversationId);
    if (conv) conv.settings.maxRounds = n;
    this.emitSession(s);
    return s;
  }

  async loop(session) {
    const rt = this.runtime.get(session.id);
    let endStatus = 'done';
    let reason = null;
    let synthDone = false;
    while (true) {
      if (rt.stopRequested) { endStatus = 'stopped'; reason = rt.stopReason; break; }
      if (rt.synthRequested) { await this.runSynthesis(session); synthDone = true; reason = 'Đã chốt ý'; break; }
      if (session.round >= Math.min(session.maxRounds, HARD_MAX_ROUNDS)) { reason = `Đạt số vòng tối đa (${session.round}/${session.maxRounds})`; break; }

      const round = session.round + 1;
      const agents = session.participants.filter((id) => this.usable(id));
      if (!agents.length) { endStatus = 'error'; reason = 'Không còn AI nào kết nối được'; break; }
      session.round = round;
      this.emitSession(session);

      const shared = ctx.sharedContext(this.store, this.store.conversation(session.conversationId), session, this.limits);
      const sess = ctx.sessionContext(this.store, session, round, this.limits);
      const prompt = shared ? `${shared}\n\n${sess}` : sess;
      const results = await Promise.all(agents.map((id, i) => this.runCall(session, id, {
        kind: 'discussion', round, prompt,
        system: ctx.systemPrompt({
          agentName: this.adapters.get(id).name,
          others: agents.filter((x) => x !== id).map((x) => this.adapters.get(x).name),
          round, maxRounds: session.maxRounds, roleIndex: i + round - 1, words: this.limits.replyWords,
        }),
        maxOutputTokens: this.limits.maxOutputTokens,
      })));

      if (rt.stopRequested) { endStatus = 'stopped'; reason = rt.stopReason; break; }
      const ok = results.filter((r) => r.ok);
      if (!ok.length) { endStatus = 'error'; reason = `Tất cả AI đều lỗi ở vòng ${round}`; break; }
      const quiet = (r) => r.skipped || r.state === 'KHONG_MOI' || r.state === 'THONG_NHAT';
      if (ok.every((r) => r.state === 'CAN_QUYET_DINH')) { reason = 'Các AI cần bạn quyết định'; break; }
      if (round >= 2 && ok.every((r) => quiet(r) || r.state === 'CAN_QUYET_DINH')) {
        reason = ok.some((r) => r.state === 'CAN_QUYET_DINH') ? 'Dừng sớm: cần bạn quyết định'
          : ok.every((r) => r.state === 'THONG_NHAT') ? 'Dừng sớm: các bên đã thống nhất' : 'Dừng sớm: không còn ý mới';
        break;
      }
    }
    // Chốt ý được yêu cầu đúng lúc vòng cuối vừa xong.
    if (endStatus === 'done' && rt.synthRequested && !synthDone) { await this.runSynthesis(session); reason = 'Đã chốt ý'; }
    if (endStatus === 'done' && !rt.stopRequested) await this.maybeUpdateSummary(session);
    this.finish(session, rt.stopRequested ? 'stopped' : endStatus, rt.stopRequested ? rt.stopReason : reason);
  }

  finish(session, status, reason) {
    if (!ACTIVE.includes(session.status) && session.endedAt) return;
    session.status = status;
    session.stopReason = reason || null;
    session.endedAt = new Date().toISOString();
    this.runtime.delete(session.id);
    this.emitSession(session);
  }

  // Một lượt gọi tới một AI. Luôn trả về kết quả (không ném lỗi) để một AI lỗi không làm treo vòng.
  async runCall(session, agentId, { kind, round, system, prompt, maxOutputTokens }) {
    const rt = this.runtime.get(session.id);
    const adapter = this.adapters.get(agentId);
    const callId = newId('call');
    const msg = this.store.addMessage({
      conversationId: session.conversationId, sessionId: session.id, callId, role: 'agent', kind,
      agentId, agentName: adapter.name, simulated: adapter.type === 'mock', round, status: 'waiting',
    });
    this.emit('event', { conversationId: session.conversationId, type: 'message', payload: msg });
    session.calls.total += 1;
    session.calls.byAgent[agentId] = (session.calls.byAgent[agentId] || 0) + 1;
    this.emitSession(session);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.limits.callTimeoutSec * 1000);
    let raw = '';
    // Hủy được hay không, runCall vẫn kết thúc ngay khi bị dừng; phản hồi đến muộn bị bỏ qua.
    let abortWait;
    const aborted = new Promise((resolve) => { abortWait = resolve; });
    controller.signal.addEventListener('abort', () => abortWait({ aborted: true }));
    rt.calls.set(callId, { controller, messageId: msg.id });

    const isCurrent = () => msg.status === 'waiting' || msg.status === 'streaming';
    try {
      const outcome = await Promise.race([
        adapter.call({
          system, prompt, maxOutputTokens, signal: controller.signal,
          onDelta: (d) => {
            if (!isCurrent()) return; // phản hồi đến muộn của phiên đã dừng
            raw += d;
            msg.status = 'streaming';
            msg.content = ctx.visiblePartial(raw);
            this.emit('event', { conversationId: session.conversationId, type: 'message', payload: msg });
          },
        }).then((r) => ({ result: r }), (e) => ({ error: e })),
        aborted,
      ]);
      if (!isCurrent()) return { ok: false, cancelled: true };
      if (outcome.aborted && !timedOut) { this.markCancelled(msg); return { ok: false, cancelled: true }; }
      if (outcome.aborted && timedOut) {
        Object.assign(msg, { status: 'error', error: `Hết thời gian chờ (${this.limits.callTimeoutSec} giây)` });
        return { ok: false };
      }
      if (outcome.error) {
        const e = outcome.error;
        if (e.code === 'cancelled') { this.markCancelled(msg); return { ok: false, cancelled: true }; }
        Object.assign(msg, { status: 'error', error: `${labelError(e.code)}: ${String(e.message).slice(0, 300)}` });
        if (['auth', 'quota', 'unavailable'].includes(e.code)) {
          this.setAgentState(agentId, { error: `${labelError(e.code)}: ${String(e.message).slice(0, 200)}`, connectedAt: null });
        }
        return { ok: false };
      }
      const parsed = kind === 'discussion' ? ctx.parseReply(outcome.result.text) : { content: outcome.result.text.trim(), state: null, skipped: false };
      Object.assign(msg, {
        status: parsed.skipped ? 'skipped' : 'done',
        content: parsed.skipped ? '' : parsed.content,
        meta: { state: parsed.state },
        usage: outcome.result.usage || null,
      });
      if (!(this.store.data.agentState[agentId] || {}).connectedAt) this.setAgentState(agentId, { connectedAt: new Date().toISOString(), error: null });
      return { ok: true, state: parsed.state, skipped: parsed.skipped, content: parsed.content, messageId: msg.id };
    } finally {
      clearTimeout(timer);
      rt.calls.delete(callId);
      this.store.save();
      this.emit('event', { conversationId: session.conversationId, type: 'message', payload: msg });
    }
  }

  markCancelled(msg) {
    if (msg.status === 'waiting' || msg.status === 'streaming') {
      msg.status = 'cancelled';
      this.emit('event', { conversationId: msg.conversationId, type: 'message', payload: msg });
    }
  }

  // Dừng: không tạo yêu cầu mới, hủy yêu cầu đang chạy, giữ lại những gì đã nhận.
  stop(sessionId, reason = 'Người dùng bấm Dừng') {
    const s = this.store.session(sessionId);
    if (!s) throw notFound('phiên');
    const rt = this.runtime.get(sessionId);
    if (!rt || !ACTIVE.includes(s.status)) return s;
    rt.stopRequested = true;
    rt.stopReason = reason;
    s.status = 'stopping';
    for (const { controller, messageId } of rt.calls.values()) {
      const m = this.store.message(messageId);
      if (m) this.markCancelled(m);
      controller.abort();
    }
    this.emitSession(s);
    return s;
  }

  latestSession(conversationId) {
    const list = this.store.sessionsOf(conversationId);
    return list[list.length - 1] || null;
  }

  // "Thảo luận tiếp": thêm đúng một vòng từ trạng thái hiện tại, tổng không vượt 100.
  continueSession(sessionId) {
    const s = this.store.session(sessionId);
    if (!s) throw notFound('phiên');
    if (ACTIVE.includes(s.status)) throw conflict('Phiên đang chạy');
    if (s.round >= HARD_MAX_ROUNDS) throw limit('Phiên đã đạt 100 vòng. Hãy gửi tin mới để bắt đầu phiên mới; bản tóm tắt được giữ lại.');
    if (this.busyCount() >= this.limits.maxConcurrentSessions) throw limit('Đã đạt giới hạn phiên chạy đồng thời');
    const usable = s.participants.filter((id) => this.usable(id));
    if (!usable.length) throw bad('Không còn AI nào của phiên này đang kết nối');
    s.maxRounds = s.round + 1;
    s.status = 'running';
    s.stopReason = null;
    s.endedAt = null;
    this.emitSession(s);
    this.launch(s);
    return s;
  }

  // "Chốt ý": dừng tạo vòng mới, chỉ một AI tổng hợp.
  synthesize(sessionId) {
    const s = this.store.session(sessionId);
    if (!s) throw notFound('phiên');
    const rt = this.runtime.get(sessionId);
    if (rt && ACTIVE.includes(s.status)) {
      if (rt.stopRequested) throw conflict('Phiên đang dừng');
      rt.synthRequested = true; // vòng hiện tại hoàn tất rồi chỉ một lượt tổng hợp, không thêm vòng tranh luận
      s.status = 'synthesizing';
      this.emitSession(s);
      return s;
    }
    if (this.busyCount() >= this.limits.maxConcurrentSessions) throw limit('Đã đạt giới hạn phiên chạy đồng thời');
    if (!this.pickSynthesizer(s)) throw bad('Không có AI nào đang kết nối để chốt ý');
    s.status = 'synthesizing';
    s.endedAt = null;
    this.runtime.set(s.id, { stopRequested: false, synthRequested: true, calls: new Map() });
    this.emitSession(s);
    const p = (async () => {
      await this.runSynthesis(s);
      const rt2 = this.runtime.get(s.id);
      this.finish(s, rt2 && rt2.stopRequested ? 'stopped' : 'done', rt2 && rt2.stopRequested ? rt2.stopReason : 'Đã chốt ý');
    })();
    this.loops.set(s.id, p);
    return s;
  }

  pickSynthesizer(s) {
    const order = [...(this.limits.synthesisOrder || []), ...s.participants, ...this.adapters.keys()];
    return order.find((id) => this.adapters.has(id) && this.usable(id) && s.participants.includes(id))
      || order.find((id) => this.adapters.has(id) && this.usable(id)) || null;
  }

  async runSynthesis(session) {
    const id = this.pickSynthesizer(session);
    if (!id) return;
    session.status = 'synthesizing';
    this.emitSession(session);
    const conv = this.store.conversation(session.conversationId);
    const shared = ctx.sharedContext(this.store, conv, session, this.limits);
    const transcript = ctx.transcriptOfSession(this.store, session, 9000);
    const r = await this.runCall(session, id, {
      kind: 'synthesis', round: session.round,
      system: ctx.synthesisSystemPrompt({ agentName: this.adapters.get(id).name, words: '150–250' }),
      prompt: `${shared ? `${shared}\n\n` : ''}[DIỄN BIẾN THẢO LUẬN]\n${transcript}\n\nHãy chốt ý.`,
      maxOutputTokens: this.limits.synthesisMaxOutputTokens,
    });
    if (r.ok) {
      session.synthesisMessageId = r.messageId;
      // Bản chốt ý dùng luôn làm tóm tắt chung, không tốn thêm lượt gọi tóm tắt.
      const msgs = this.store.messagesOf(conv.id);
      conv.summary = { text: r.content, upToMessageId: msgs[msgs.length - 1].id, updatedAt: new Date().toISOString() };
      this.emit('event', { conversationId: conv.id, type: 'conversation', payload: conv });
    }
  }

  // Chỉ cập nhật tóm tắt khi phần chưa tóm tắt vượt ngưỡng. Lượt gọi này được tính vào bộ đếm.
  async maybeUpdateSummary(session) {
    const conv = this.store.conversation(session.conversationId);
    const msgs = this.store.messagesOf(conv.id).filter((m) => m.status === 'done' && m.content);
    let start = 0;
    if (conv.summary.upToMessageId) {
      const i = msgs.findIndex((m) => m.id === conv.summary.upToMessageId);
      if (i >= 0) start = i + 1;
    }
    const pending = msgs.slice(start);
    const size = pending.reduce((n, m) => n + m.content.length, 0);
    if (size < this.limits.summaryThresholdChars) return;
    const id = this.pickSynthesizer(session);
    if (!id) return;
    const body = pending.map((m) => `- ${m.role === 'user' ? 'Người dùng' : m.agentName}: ${ctx.clip(m.content, 700)}`).join('\n');
    const r = await this.runCall(session, id, {
      kind: 'summary', round: session.round,
      system: ctx.summarySystemPrompt(),
      prompt: `[TÓM TẮT CŨ]\n${conv.summary.text || '(chưa có)'}\n\n[NỘI DUNG MỚI]\n${ctx.clip(body, 14000)}`,
      maxOutputTokens: 600,
    });
    if (r.ok) {
      conv.summary = { text: r.content, upToMessageId: pending[pending.length - 1].id, updatedAt: new Date().toISOString() };
      this.emit('event', { conversationId: conv.id, type: 'conversation', payload: conv });
    }
  }
}

function labelError(code) {
  return {
    auth: 'Lỗi xác thực', quota: 'Hết hạn mức hoặc bị giới hạn tốc độ', timeout: 'Hết thời gian chờ',
    unavailable: 'Không kết nối được', cancelled: 'Đã hủy',
  }[code] || 'Lỗi';
}

module.exports = { Orchestrator, DEFAULT_LIMITS, HARD_MAX_ROUNDS };
