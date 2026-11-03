'use strict';
// API cho agent/công cụ bên ngoài (/v1/...). Xác thực bằng Bearer key, quyền theo phạm vi.
const crypto = require('node:crypto');
const { send, readJson, safeEqual, router } = require('./http-util');
const { AppError, bad, notFound, limit } = require('./errors');
const { newId } = require('./store');

const SCOPES = ['read', 'write', 'control'];
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

// apiKeys: khóa trong config.json (dạng gốc). getExtraKeys(): khóa tạo trên giao diện (chỉ lưu mã băm SHA-256).
function makeV1Api({ store, orch, apiKeys, getExtraKeys = () => [] }) {
  const fileKeys = (apiKeys || []).filter((k) => k && k.id && typeof k.key === 'string' && k.key.length >= 24 && !/^THAY-/.test(k.key));
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const hits = new Map(); // keyId -> [timestamps]

  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) throw new AppError(401, 'unauthorized', 'Thiếu header Authorization: Bearer <key>');
    const token = m[1].trim();
    const tokenHash = sha(token);
    const k = fileKeys.find((x) => safeEqual(x.key, token)) || getExtraKeys().find((x) => safeEqual(x.hash, tokenHash));
    if (!k) throw new AppError(401, 'unauthorized', 'API key không hợp lệ');
    const now = Date.now();
    const list = (hits.get(k.id) || []).filter((t) => now - t < 60_000);
    if (list.length >= (k.requestsPerMinute || 60)) throw limit('Vượt giới hạn số yêu cầu mỗi phút');
    list.push(now);
    hits.set(k.id, list);
    return k;
  }

  const need = (key, scope) => {
    if (!(key.scopes || []).includes(scope)) throw new AppError(403, 'forbidden', `API key không có quyền "${scope}"`);
  };
  const projectAllowed = (key, projectId) => {
    const p = key.projects || [];
    return p.includes('*') || (projectId ? p.includes(projectId) : p.includes('none'));
  };
  const convFor = (key, id) => {
    const c = store.conversation(id);
    if (!c || !projectAllowed(key, c.projectId)) throw notFound('cuộc trò chuyện');
    return c;
  };
  const sessionFor = (key, id) => {
    const s = store.session(id);
    if (!s) throw notFound('phiên');
    convFor(key, s.conversationId);
    return s;
  };

  const sessionView = (s) => {
    const msgs = store.data.messages.filter((m) => m.sessionId === s.id).map((m) => ({
      id: m.id, role: m.role, kind: m.kind, agentId: m.agentId || null, agentName: m.agentName || null,
      simulated: !!m.simulated, round: m.round, status: m.status, content: m.content, error: m.error || null,
    }));
    const synth = s.synthesisMessageId ? msgs.find((m) => m.id === s.synthesisMessageId) : null;
    return Object.assign(orch.publicSession(s), { messages: msgs, synthesis: synth ? synth.content : null });
  };

  const routes = router([
    ['GET', '/v1/agents', ({ key }) => { need(key, 'read'); return { agents: orch.agents() }; }],

    ['GET', '/v1/projects', ({ key }) => {
      need(key, 'read');
      return { projects: store.data.projects.filter((p) => !p.archived && projectAllowed(key, p.id))
        .map((p) => ({ id: p.id, name: p.name, description: p.description })) };
    }],

    ['GET', '/v1/conversations', ({ key, query }) => {
      need(key, 'read');
      const pid = query.get('projectId');
      return { conversations: store.data.conversations
        .filter((c) => !c.archived && projectAllowed(key, c.projectId) && (pid === null || (c.projectId || '') === pid))
        .map((c) => ({ id: c.id, projectId: c.projectId, title: c.title, updatedAt: c.updatedAt })) };
    }],

    ['POST', '/v1/conversations', ({ key, body }) => {
      need(key, 'write');
      const projectId = body.projectId || null;
      if (projectId && !store.project(projectId)) throw notFound('dự án');
      if (!projectAllowed(key, projectId)) throw new AppError(403, 'forbidden', 'API key không được dùng dự án này');
      if (body.title !== undefined && typeof body.title !== 'string') throw bad('title phải là chuỗi');
      const c = store.createConversation({ title: body.title || 'Từ API', projectId });
      return [201, { id: c.id, projectId: c.projectId, title: c.title }];
    }],

    ['POST', '/v1/conversations/:id/sessions', ({ key, params, body, req }) => {
      need(key, 'write');
      const conv = convFor(key, params.id);
      if (typeof body.message !== 'string') throw bad('message phải là chuỗi');
      if (body.participants !== undefined && (!Array.isArray(body.participants) || body.participants.some((x) => typeof x !== 'string'))) {
        throw bad('participants phải là mảng ID agent');
      }
      if (body.maxRounds === undefined) throw bad('Thiếu maxRounds (1–100)', { field: 'maxRounds' });

      const idemKey = req.headers['idempotency-key'];
      const hash = crypto.createHash('sha256').update(JSON.stringify([params.id, body.message, body.participants || null, body.maxRounds])).digest('hex');
      const now = Date.now();
      store.data.idempotency = store.data.idempotency.filter((x) => now - Date.parse(x.createdAt) < IDEMPOTENCY_TTL_MS);
      if (idemKey) {
        if (String(idemKey).length > 200) throw bad('Idempotency-Key quá dài');
        const prev = store.data.idempotency.find((x) => x.apiKeyId === key.id && x.key === idemKey);
        if (prev) {
          if (prev.hash !== hash) throw new AppError(409, 'idempotency_mismatch', 'Idempotency-Key đã dùng cho một yêu cầu khác');
          const s = store.session(prev.sessionId);
          if (s) return [200, Object.assign(sessionView(s), { replayed: true })];
        }
      }
      const mine = orch.activeSessions().filter((s) => s.apiKeyId === key.id).length;
      if (mine >= (key.maxConcurrentSessions || 1)) throw limit('API key đã đạt giới hạn phiên chạy đồng thời');

      const s = orch.startSession({
        conversationId: conv.id, text: body.message, participants: body.participants, maxRounds: body.maxRounds,
        source: 'api', apiKeyId: key.id, requestId: newId('req'), supersede: false,
      });
      if (idemKey) store.data.idempotency.push({ apiKeyId: key.id, key: idemKey, hash, sessionId: s.id, createdAt: new Date().toISOString() });
      store.save();
      return [202, sessionView(s)];
    }],

    ['GET', '/v1/sessions/:id', ({ key, params }) => { need(key, 'read'); return sessionView(sessionFor(key, params.id)); }],

    ['GET', '/v1/sessions/:id/synthesis', ({ key, params }) => {
      need(key, 'read');
      const s = sessionFor(key, params.id);
      const v = sessionView(s);
      if (!v.synthesis) throw notFound('bản tổng hợp (chưa có; gọi POST /v1/sessions/{id}/synthesize)');
      return { sessionId: s.id, synthesis: v.synthesis };
    }],

    ['POST', '/v1/sessions/:id/stop', ({ key, params }) => {
      need(key, 'control');
      return sessionView(orch.stop(sessionFor(key, params.id).id, 'Dừng qua API'));
    }],

    ['POST', '/v1/sessions/:id/synthesize', ({ key, params }) => {
      need(key, 'control');
      return [202, sessionView(orch.synthesize(sessionFor(key, params.id).id))];
    }],
  ]);

  return async function handle(req, res, url) {
    const requestId = newId('req');
    res.setHeader('x-request-id', requestId);
    const match = routes(req.method, url.pathname);
    if (!match) throw notFound('endpoint');
    const key = authenticate(req);
    const body = req.method === 'POST' ? await readJson(req, 100_000) : {};
    let out = await match.handler({ key, params: match.params, body, query: url.searchParams, req });
    let status = 200;
    if (Array.isArray(out)) [status, out] = out;
    console.log(`[api] ${key.id} ${req.method} ${url.pathname} -> ${status}`); // không ghi nội dung
    send(res, status, out);
  };
}

module.exports = { makeV1Api, SCOPES };
