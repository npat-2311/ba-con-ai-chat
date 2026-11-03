'use strict';
// Trang Kết nối: lưu cài đặt, API key không lộ ra trình duyệt, khóa API tạo trên giao diện, kiểm tra đăng nhập (CLI giả lập).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcset-'));
  const app = createApp({
    agents: [
      { id: 'gemini', name: 'Gemini', type: 'gemini-api', model: 'gemini-2.5-flash', apiKeyEnv: 'KHONG_CO_BIEN_NAY' },
      { id: 'chatgpt', name: 'ChatGPT', type: 'cli', preset: 'codex', command: 'codex-gia-lap-khong-co' },
      { id: 'claude', name: 'Claude', type: 'mock' },
    ],
    dataFile: null, settingsFile: path.join(dir, 'settings.json'), limits: {}, apiKeys: [],
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json', 'x-phong-chat': '1' }, headers), body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { app, call, dir };
}

test('Nhập API key Gemini trên giao diện: lưu phía server, không gửi lại trình duyệt', async (t) => {
  const { app, call, dir } = await start();
  t.after(() => app.server.close());
  let st = await call('GET', '/api/settings');
  assert.equal(st.body.agents.find((a) => a.id === 'gemini').status, 'not_connected');
  const r = await call('PATCH', '/api/settings/agents/gemini', { apiKey: 'AIzaSyBIMATTHUNGHIEM1234' });
  const g = r.body.agents.find((a) => a.id === 'gemini');
  assert.equal(g.status, 'unverified');
  assert.equal(g.keyHint, '••••1234');
  assert.ok(!JSON.stringify(r.body).includes('AIzaSyBIMATTHUNGHIEM1234'));
  assert.ok(!JSON.stringify((await call('GET', '/api/state')).body).includes('AIzaSyBIMATTHUNGHIEM1234'));
  assert.match(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), /AIzaSyBIMATTHUNGHIEM1234/);
  // Tắt AI: biến mất khỏi danh sách tham gia
  await call('PATCH', '/api/settings/agents/gemini', { disabled: true });
  assert.ok(!(await call('GET', '/api/state')).body.agents.some((a) => a.id === 'gemini'));
  st = await call('GET', '/api/settings');
  assert.equal(st.body.agents.find((a) => a.id === 'gemini').status, 'disabled');
});

test('Thêm và xóa agent ngoài; chặn api.openai.com', async (t) => {
  const { app, call } = await start();
  t.after(() => app.server.close());
  const r = await call('POST', '/api/settings/agents', { name: 'Llama trên máy', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' });
  const added = r.body.agents.find((a) => a.custom);
  assert.equal(added.id, 'llama-tren-may');
  assert.ok((await call('GET', '/api/state')).body.agents.some((a) => a.id === 'llama-tren-may'));
  const oa = await call('POST', '/api/settings/agents', { name: 'OA', baseUrl: 'https://api.openai.com/v1', model: 'x' });
  assert.equal(oa.body.agents.find((a) => a.id === 'oa').status, 'not_connected');
  assert.equal((await call('DELETE', '/api/settings/agents/claude')).status, 400, 'không xóa agent gốc');
  assert.equal((await call('DELETE', '/api/settings/agents/llama-tren-may')).status, 200);
});

test('Khóa API tạo trên giao diện dùng được cho /v1, hiện một lần, thu hồi được', async (t) => {
  const { app, call, dir } = await start();
  t.after(() => app.server.close());
  const k = await call('POST', '/api/settings/api-keys', { name: 'agent-a', scopes: ['read'], projects: ['*'] });
  assert.equal(k.status, 200);
  assert.match(k.body.key, /^pc_/);
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes(k.body.key), 'chỉ lưu mã băm');
  const auth = { authorization: `Bearer ${k.body.key}` };
  assert.equal((await call('GET', '/v1/projects', null, auth)).status, 200);
  assert.equal((await call('POST', '/v1/conversations', {}, auth)).status, 403);
  assert.ok(!JSON.stringify((await call('GET', '/api/settings')).body).includes(k.body.key));
  await call('DELETE', '/api/settings/api-keys/agent-a');
  assert.equal((await call('GET', '/v1/projects', null, auth)).status, 401);
});

test('Kiểm tra đăng nhập CLI (giả lập): phát hiện chưa cài, đăng nhập thuê bao, đăng nhập API key trả phí', { skip: process.platform === 'win32' }, async () => {
  const { authStatus } = require('../src/jobs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbin-'));
  const fake = (name, out) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho '${out}'\n`, { mode: 0o755 });
  assert.equal((await authStatus({ id: 'c', preset: 'codex', command: path.join(dir, 'khong-co') })).installed, false);
  fake('codex1', 'Logged in using ChatGPT');
  let r = await authStatus({ id: 'c', preset: 'codex', command: path.join(dir, 'codex1') });
  assert.equal(r.loggedIn, true); assert.equal(r.paid, false);
  fake('codex2', 'Logged in using an API key - sk-proj-abcdefghijkl');
  r = await authStatus({ id: 'c', preset: 'codex', command: path.join(dir, 'codex2') });
  assert.equal(r.paid, true);
  assert.ok(!r.raw.includes('abcdefghijkl'), 'che key trong đầu ra');
  fake('codex3', 'Not logged in');
  assert.equal((await authStatus({ id: 'c', preset: 'codex', command: path.join(dir, 'codex3') })).loggedIn, false);
  fake('claude1', '{"loggedIn": true, "authMethod": "claude.ai"}');
  r = await authStatus({ id: 'x', preset: 'claude', command: path.join(dir, 'claude1') });
  assert.equal(r.loggedIn, true); assert.equal(r.paid, false);
});

test('Nút đăng nhập/cài đặt chỉ chạy lệnh cố định', async (t) => {
  const { app, call } = await start();
  t.after(() => app.server.close());
  assert.equal((await call('POST', '/api/settings/agents/chatgpt/jobs', { kind: 'rm -rf' })).status, 400);
  const r = await call('POST', '/api/settings/agents/chatgpt/jobs', { kind: 'login' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /Chưa cài/);
});

test('Nút Đăng nhập chạy lệnh đăng nhập chính thức, hiện liên kết, nhận mã dán vào', { skip: process.platform === 'win32' }, async () => {
  const { Jobs } = require('../src/jobs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcjob-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\necho "Open https://claude.ai/oauth/authorize?code=1 to sign in"\nread code\necho "got $code"\n', { mode: 0o755 });
  const jobs = new Jobs();
  const j = jobs.start({ id: 'claude', preset: 'claude', command: bin }, 'login');
  await new Promise((r) => setTimeout(r, 300));
  assert.match(jobs.get(j.id).lines.join('\n'), /https:\/\/claude\.ai\/oauth/);
  assert.throws(() => jobs.start({ id: 'claude', preset: 'claude', command: bin }, 'login'), /Đang có/);
  jobs.input(j.id, 'MA-123');
  await new Promise((r) => setTimeout(r, 300));
  const done = jobs.get(j.id);
  assert.equal(done.done, true);
  assert.equal(done.exitCode, 0);
  assert.match(done.lines.join('\n'), /got MA-123/);
});
