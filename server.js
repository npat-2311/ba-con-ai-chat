'use strict';
// Phòng chat AI — server local. Khởi động: `npm start` (thật) hoặc `npm run mock` (AI giả lập).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./src/store');
const { buildAdapters } = require('./src/adapters');
const { Orchestrator } = require('./src/orchestrator');
const { makeUiApi } = require('./src/api-ui');
const { makeV1Api } = require('./src/api-v1');
const { Settings } = require('./src/settings');
const { Jobs, authStatus } = require('./src/jobs');
const { send, sendError, safeEqual } = require('./src/http-util');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function loadConfig(argv) {
  const mock = argv.includes('--mock');
  const file = process.env.PHONG_CHAT_CONFIG || path.join(ROOT, 'config.json');
  const fallback = path.join(ROOT, 'config.example.json');
  const used = fs.existsSync(file) ? file : fallback;
  const cfg = JSON.parse(fs.readFileSync(used, 'utf8'));
  cfg._file = used;
  cfg.host = process.env.HOST || cfg.host || '127.0.0.1';
  cfg.port = Number(process.env.PORT || cfg.port || 8787);
  cfg.uiPassword = process.env.PHONG_CHAT_UI_PASSWORD || cfg.uiPassword || '';
  if (mock) {
    cfg.agents = [
      { id: 'gemini', name: 'Gemini', type: 'mock', delayMs: 400 },
      { id: 'chatgpt', name: 'ChatGPT', type: 'mock', delayMs: 600 },
      { id: 'claude', name: 'Claude', type: 'mock', delayMs: 500, agreeFromRound: 3 },
    ];
    cfg.dataFile = path.join(ROOT, 'data', 'mock-db.json');
    cfg.settingsFile = path.join(ROOT, 'data', 'mock-settings.json');
  }
  cfg.dataFile = cfg.dataFile || path.join(ROOT, 'data', 'db.json');
  if (cfg.settingsFile === undefined) cfg.settingsFile = path.join(ROOT, 'data', 'settings.json');
  cfg.mock = mock;
  return cfg;
}

function createApp(cfg) {
  const store = new Store(cfg.dataFile);
  store.recoverAfterRestart();
  const settings = new Settings(cfg.settingsFile || null, cfg.agents);
  const orch = new Orchestrator(store, buildAdapters(settings.effectiveAgents()), cfg.limits);
  const rebuild = (resetIds) => orch.setAdapters(buildAdapters(settings.effectiveAgents()), resetIds);
  const jobs = new Jobs();
  const uiApi = makeUiApi({ store, orch, settings, jobs, authStatus, rebuild });
  const v1Api = makeV1Api({ store, orch, apiKeys: cfg.apiKeys, getExtraKeys: () => settings.data.apiKeys });
  const openapi = fs.readFileSync(path.join(ROOT, 'docs', 'openapi.json'), 'utf8');
  const allowedHosts = new Set((cfg.allowedHosts || []).map((h) => h.toLowerCase()));

  function hostOk(req) {
    if (cfg.uiPassword) return true; // đã có mật khẩu
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return LOOPBACK.has(host) || allowedHosts.has(host);
  }

  function uiAuthOk(req) {
    if (!cfg.uiPassword) return true;
    const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (!m) return false;
    const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
    return safeEqual(pass, cfg.uiPassword);
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: { code: 'not_found', message: 'Không tìm thấy' } });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  }

  function events(req, res, url) {
    const conversationId = url.searchParams.get('conversationId');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': ok\n\n');
    const onEvent = (ev) => {
      if (ev.type !== 'agents' && ev.conversationId !== conversationId) return;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
    };
    orch.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); orch.off('event', onEvent); });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (!hostOk(req)) return send(res, 421, { error: { code: 'bad_host', message: 'Host không được phép' } });

      if (url.pathname === '/v1/openapi.json') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(openapi); }
      if (url.pathname.startsWith('/v1/')) return await v1Api(req, res, url);

      if (!uiAuthOk(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Phong chat AI", charset="UTF-8"' });
        return res.end('Cần đăng nhập');
      }
      if (url.pathname.startsWith('/api/')) {
        // Chống trang web lạ gửi yêu cầu tới server local (CSRF): mọi yêu cầu ghi phải có header riêng.
        if (req.method !== 'GET' && req.headers['x-phong-chat'] !== '1') return send(res, 403, { error: { code: 'forbidden', message: 'Thiếu header X-Phong-Chat' } });
        if (url.pathname === '/api/events') return events(req, res, url);
        if (await uiApi(req, res, url)) return;
        return send(res, 404, { error: { code: 'not_found', message: 'Không tìm thấy' } });
      }
      if (req.method === 'GET') return serveStatic(res, url.pathname);
      send(res, 405, { error: { code: 'method_not_allowed', message: 'Không hỗ trợ' } });
    } catch (e) {
      sendError(res, e, res.getHeader('x-request-id'));
    }
  });
  return { server, store, orch, settings };
}

if (require.main === module) {
  const cfg = loadConfig(process.argv.slice(2));
  if (!LOOPBACK.has(cfg.host) && !cfg.uiPassword) {
    console.error(`Từ chối chạy trên ${cfg.host} khi chưa đặt uiPassword. Hãy đặt mật khẩu hoặc dùng 127.0.0.1.`);
    process.exit(1);
  }
  const { server, store, orch } = createApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Phòng chat AI: http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`);
    console.log(`Cấu hình: ${path.relative(ROOT, cfg._file)}${cfg.mock ? ' — CHẾ ĐỘ GIẢ LẬP (không gọi AI thật)' : ''}`);
    for (const a of orch.agents()) console.log(`  - ${a.name}: ${a.status} (${a.detail})`);
  });
  const shutdown = () => { store.saveNow(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, loadConfig };
