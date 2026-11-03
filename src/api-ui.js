'use strict';
// API nội bộ cho giao diện web (/api/...). Chỉ dùng từ cùng origin; mọi lệnh ghi cần header X-Phong-Chat.
const { send, readJson, router } = require('./http-util');
const { bad, notFound } = require('./errors');

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function str(v, max, field) {
  if (typeof v !== 'string') throw bad(`${field} phải là chuỗi`);
  return v.slice(0, max);
}

const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const { suggestionsFor, listModels } = require('./models');

function makeUiApi({ store, orch, settings, jobs, authStatus, rebuild }) {
  // Cài đặt CLI / đăng nhập chỉ được bấm từ chính máy chạy server, không từ điện thoại hay máy khác.
  const localOnly = (req) => {
    if (!LOOPBACK_ADDR.has(req.socket.remoteAddress)) throw bad('Thao tác này chỉ làm được trên chính máy đang chạy ứng dụng');
  };
  const agentCfg = (id) => {
    const a = settings.effectiveAgents().find((x) => x.id === id);
    if (!a) throw notFound('AI/agent');
    return a;
  };
  const settingsView = () => {
    const live = new Map(orch.agents().map((a) => [a.id, a]));
    return {
      agents: settings.effectiveAgents().map((a) => Object.assign(settings.publicAgent(a), {
        status: a.disabled ? 'disabled' : (live.get(a.id) || {}).status || 'not_connected',
        detail: (live.get(a.id) || {}).detail || '',
        costSource: a.costSource || '',
        simulated: a.type === 'mock',
        canLogin: a.type === 'cli' && ['codex', 'claude'].includes(a.preset),
        suggestions: suggestionsFor(a),
        canListModels: a.type === 'gemini-api' || a.type === 'openai-compat',
      })),
      apiKeys: settings.publicApiKeys(),
      projects: store.data.projects.map((p) => ({ id: p.id, name: p.name })),
    };
  };
  const wrap = (fn) => { try { return fn(); } catch (e) { if (e.status) throw e; throw bad(e.message); } };
  const convSummary = (c) => ({
    id: c.id, projectId: c.projectId, title: c.title, pinned: c.pinned, archived: c.archived,
    settings: c.settings, updatedAt: c.updatedAt, createdAt: c.createdAt,
  });

  const routes = router([
    ['GET', '/api/state', () => ({
      projects: store.data.projects,
      conversations: store.data.conversations.map(convSummary),
      agents: orch.agents(),
      limits: { maxConcurrentSessions: orch.limits.maxConcurrentSessions, hardMaxRounds: 100 },
    })],

    ['GET', '/api/conversations/:id', ({ params }) => {
      const c = store.conversation(params.id);
      if (!c) throw notFound('cuộc trò chuyện');
      return { conversation: c, messages: store.messagesOf(c.id), session: orch.publicSession(orch.latestSession(c.id)) };
    }],

    ['POST', '/api/projects', ({ body }) => store.createProject({
      name: str(body.name || 'Dự án mới', 200, 'name'),
      description: str(body.description || '', 2000, 'description'),
      goal: str(body.goal || '', 4000, 'goal'),
      instructions: str(body.instructions || '', 4000, 'instructions'),
    })],

    ['PATCH', '/api/projects/:id', ({ params, body }) => {
      const p = store.project(params.id);
      if (!p) throw notFound('dự án');
      const patch = pick(body, ['name', 'description', 'goal', 'instructions', 'pinned', 'archived']);
      for (const k of ['name', 'description', 'goal', 'instructions']) if (k in patch) patch[k] = str(patch[k], 4000, k);
      for (const k of ['pinned', 'archived']) if (k in patch) patch[k] = !!patch[k];
      Object.assign(p, patch, { updatedAt: new Date().toISOString() });
      store.save();
      return p;
    }],

    ['DELETE', '/api/projects/:id', ({ params, query }) => {
      if (!store.project(params.id)) throw notFound('dự án');
      const mode = query.get('mode');
      if (!['delete', 'detach'].includes(mode)) throw bad('mode phải là delete hoặc detach');
      const running = orch.activeSessions().some((s) => store.conversation(s.conversationId)?.projectId === params.id);
      if (running) throw bad('Dự án đang có phiên thảo luận chạy. Hãy dừng trước khi xóa.');
      return { affectedConversations: store.deleteProject(params.id, mode), mode };
    }],

    ['POST', '/api/conversations', ({ body }) => {
      if (body.projectId && !store.project(body.projectId)) throw notFound('dự án');
      return convSummary(store.createConversation({
        title: str(body.title || 'Cuộc trò chuyện mới', 200, 'title'),
        projectId: body.projectId || null,
        participants: null,
      }));
    }],

    ['PATCH', '/api/conversations/:id', ({ params, body }) => {
      const c = store.conversation(params.id);
      if (!c) throw notFound('cuộc trò chuyện');
      if ('title' in body) c.title = str(body.title, 200, 'title');
      if ('pinned' in body) c.pinned = !!body.pinned;
      if ('archived' in body) c.archived = !!body.archived;
      if ('projectId' in body) {
        if (body.projectId && !store.project(body.projectId)) throw notFound('dự án');
        c.projectId = body.projectId || null;
      }
      if ('summary' in body) c.summary = Object.assign(c.summary, { text: str(body.summary, 6000, 'summary'), updatedAt: new Date().toISOString() });
      if (body.settings) {
        if ('maxRounds' in body.settings) c.settings.maxRounds = require('./errors').parseMaxRounds(body.settings.maxRounds);
        if (Array.isArray(body.settings.participants)) c.settings.participants = body.settings.participants.filter((x) => typeof x === 'string').slice(0, 20);
      }
      c.updatedAt = new Date().toISOString();
      store.save();
      return convSummary(c);
    }],

    ['DELETE', '/api/conversations/:id', ({ params }) => {
      if (!store.conversation(params.id)) throw notFound('cuộc trò chuyện');
      for (const s of orch.activeSessions().filter((x) => x.conversationId === params.id)) orch.stop(s.id, 'Cuộc trò chuyện bị xóa');
      store.deleteConversation(params.id);
      return { deleted: true };
    }],

    ['PATCH', '/api/messages/:id', ({ params, body }) => {
      const m = store.message(params.id);
      if (!m) throw notFound('tin nhắn');
      if ('pinned' in body) m.pinned = !!body.pinned;
      store.save();
      return m;
    }],

    ['POST', '/api/conversations/:id/send', ({ params, body }) => orch.publicSession(orch.startSession({
      conversationId: params.id, text: body.text, participants: body.participants, maxRounds: body.maxRounds, source: 'ui',
    }))],

    ['POST', '/api/sessions/:id/stop', ({ params }) => orch.publicSession(orch.stop(params.id))],
    ['POST', '/api/sessions/:id/continue', ({ params }) => orch.publicSession(orch.continueSession(params.id))],
    ['POST', '/api/sessions/:id/synthesize', ({ params }) => orch.publicSession(orch.synthesize(params.id))],
    ['PATCH', '/api/sessions/:id', ({ params, body }) => orch.publicSession(orch.setMaxRounds(params.id, body.maxRounds))],
    ['POST', '/api/agents/:id/test', ({ params }) => orch.testAgent(params.id)],

    // ---- Trang Kết nối ----
    ['GET', '/api/settings', () => settingsView()],
    ['PATCH', '/api/settings/agents/:id', ({ params, body }) => {
      agentCfg(params.id);
      wrap(() => settings.patchAgent(params.id, body));
      rebuild([params.id]);
      return settingsView();
    }],
    ['POST', '/api/settings/agents', ({ body }) => {
      const id = wrap(() => settings.addCustomAgent(body));
      rebuild([id]);
      return settingsView();
    }],
    ['DELETE', '/api/settings/agents/:id', ({ params }) => {
      if (!settings.removeCustomAgent(params.id)) throw bad('Chỉ xóa được agent bạn tự thêm');
      rebuild([params.id]);
      return settingsView();
    }],
    ['GET', '/api/settings/agents/:id/models', async ({ params }) => {
      try { return { models: await listModels(agentCfg(params.id)) }; } catch (e) { throw bad(e.message); }
    }],
    ['GET', '/api/settings/agents/:id/auth-status', async ({ params }) => authStatus(agentCfg(params.id))],
    ['POST', '/api/settings/agents/:id/jobs', ({ params, body, req }) => {
      localOnly(req);
      if (!['login', 'loginDevice', 'install'].includes(body.kind)) throw bad('kind không hợp lệ');
      return wrap(() => jobs.start(agentCfg(params.id), body.kind));
    }],
    ['GET', '/api/jobs/:id', ({ params }) => jobs.get(params.id) || (() => { throw notFound('thao tác'); })()],
    ['POST', '/api/jobs/:id/input', ({ params, body, req }) => { localOnly(req); return { ok: jobs.input(params.id, String(body.text || '')) }; }],
    ['POST', '/api/jobs/:id/cancel', ({ params }) => {
      const ok = jobs.cancel(params.id);
      rebuild([]);
      return { ok };
    }],
    ['POST', '/api/settings/api-keys', ({ body }) => wrap(() => settings.createApiKey(body))],
    ['DELETE', '/api/settings/api-keys/:id', ({ params }) => {
      if (!settings.revokeApiKey(params.id)) throw notFound('khóa');
      return settingsView();
    }],
  ]);

  return async function handle(req, res, url) {
    const match = routes(req.method, url.pathname);
    if (!match) return false;
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
    const result = await match.handler({ params: match.params, body, query: url.searchParams, req });
    send(res, 200, result);
    return true;
  };
}

module.exports = { makeUiApi };
