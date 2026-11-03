'use strict';
// Kiểm tra API bên ngoài (/v1) và API giao diện qua HTTP thật, với adapter GIẢ LẬP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

const KEY_FULL = 'k-full-0123456789abcdefghijklmnop';
const KEY_READ = 'k-read-0123456789abcdefghijklmnop';
const KEY_PROJ = 'k-proj-0123456789abcdefghijklmnop';

async function start() {
  const cfg = {
    agents: ['gemini', 'chatgpt', 'claude'].map((id) => ({ id, name: id, type: 'mock', delayMs: 20 })),
    dataFile: null,
    limits: { maxConcurrentSessions: 3, callTimeoutSec: 5 },
    apiKeys: [
      { id: 'full', key: KEY_FULL, scopes: ['read', 'write', 'control'], projects: ['*'], maxConcurrentSessions: 1 },
      { id: 'read', key: KEY_READ, scopes: ['read'], projects: ['*'] },
      { id: 'proj', key: KEY_PROJ, scopes: ['read', 'write', 'control'], projects: [], maxConcurrentSessions: 1 },
      { id: 'placeholder', key: 'THAY-BANG-CHUOI-NGAU-NHIEN-DAI-IT-NHAT-24-KY-TU', scopes: ['read'], projects: ['*'] },
    ],
  };
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const h = Object.assign({ 'content-type': 'application/json' }, headers);
    if (key) h.authorization = `Bearer ${key}`;
    const res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { app, call, base };
}

test('API ngoài: xác thực, phạm vi quyền, chống trùng, giới hạn', async (t) => {
  const { app, call } = await start();
  t.after(() => app.server.close());

  assert.equal((await call('GET', '/v1/projects')).status, 401);
  assert.equal((await call('GET', '/v1/projects', { key: 'sai' })).status, 401);
  assert.equal((await call('GET', '/v1/projects', { key: 'THAY-BANG-CHUOI-NGAU-NHIEN-DAI-IT-NHAT-24-KY-TU' })).status, 401, 'khóa mẫu không dùng được');
  assert.equal((await call('GET', '/v1/projects', { key: KEY_READ })).status, 200);
  const denied = await call('POST', '/v1/conversations', { key: KEY_READ, body: { title: 'x' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');

  const conv = await call('POST', '/v1/conversations', { key: KEY_FULL, body: { title: 'Từ agent' } });
  assert.equal(conv.status, 201);

  for (const maxRounds of [0, 101, 1.5, 'x']) {
    const r = await call('POST', `/v1/conversations/${conv.body.id}/sessions`, { key: KEY_FULL, body: { message: 'hi', maxRounds } });
    assert.equal(r.status, 400, `maxRounds=${maxRounds}`);
    assert.equal(r.body.error.code, 'invalid_request');
  }
  assert.equal((await call('POST', `/v1/conversations/${conv.body.id}/sessions`, { key: KEY_FULL, body: { message: 'hi' } })).status, 400);

  const body = { message: 'Chủ đề', maxRounds: 2, participants: ['gemini', 'claude'] };
  const s1 = await call('POST', `/v1/conversations/${conv.body.id}/sessions`, { key: KEY_FULL, body, headers: { 'idempotency-key': 'abc' } });
  assert.equal(s1.status, 202);
  assert.ok(s1.body.id && s1.body.requestId);
  const s1b = await call('POST', `/v1/conversations/${conv.body.id}/sessions`, { key: KEY_FULL, body, headers: { 'idempotency-key': 'abc' } });
  assert.equal(s1b.status, 200);
  assert.equal(s1b.body.id, s1.body.id, 'gửi lại không tạo phiên mới');
  assert.equal(s1b.body.replayed, true);
  const mismatch = await call('POST', `/v1/conversations/${conv.body.id}/sessions`, { key: KEY_FULL, body: { ...body, message: 'khác' }, headers: { 'idempotency-key': 'abc' } });
  assert.equal(mismatch.status, 409);

  const conv2 = await call('POST', '/v1/conversations', { key: KEY_FULL, body: {} });
  const over = await call('POST', `/v1/conversations/${conv2.body.id}/sessions`, { key: KEY_FULL, body: { message: 'x', maxRounds: 1 } });
  assert.equal(over.status, 429, 'giới hạn phiên đồng thời theo key');

  let st;
  for (let i = 0; i < 50; i++) {
    st = await call('GET', `/v1/sessions/${s1.body.id}`, { key: KEY_READ });
    if (!['running', 'stopping', 'synthesizing'].includes(st.body.status)) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(st.body.status, 'done');
  assert.equal(st.body.round, 2);
  assert.deepEqual(st.body.calls.byAgent, { gemini: 2, claude: 2 });
  assert.ok(st.body.messages.every((m) => m.role === 'user' || m.simulated === true), 'giả lập được gắn nhãn');

  assert.equal((await call('POST', `/v1/sessions/${s1.body.id}/synthesize`, { key: KEY_READ })).status, 403);
  assert.equal((await call('POST', `/v1/sessions/${s1.body.id}/synthesize`, { key: KEY_FULL })).status, 202);
  let syn;
  for (let i = 0; i < 50; i++) {
    syn = await call('GET', `/v1/sessions/${s1.body.id}/synthesis`, { key: KEY_FULL });
    if (syn.status === 200) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.match(syn.body.synthesis, /Kết luận/);

  // Key bị giới hạn dự án không thấy cuộc trò chuyện ngoài phạm vi
  assert.equal((await call('GET', `/v1/sessions/${s1.body.id}`, { key: KEY_PROJ })).status, 404);
  assert.equal((await call('POST', '/v1/conversations', { key: KEY_PROJ, body: {} })).status, 403);

  // Dừng phiên qua API
  const conv3 = await call('POST', '/v1/conversations', { key: KEY_FULL, body: {} });
  const s3 = await call('POST', `/v1/conversations/${conv3.body.id}/sessions`, { key: KEY_FULL, body: { message: 'x', maxRounds: 100 } });
  assert.equal(s3.status, 202);
  const stopped = await call('POST', `/v1/sessions/${s3.body.id}/stop`, { key: KEY_FULL });
  assert.equal(stopped.status, 200);
  await app.orch.loops.get(s3.body.id);
  assert.equal(app.store.session(s3.body.id).status, 'stopped');
  assert.ok(app.store.session(s3.body.id).round <= 1);
});

test('API giao diện: yêu cầu ghi phải có header chống CSRF; Host lạ bị từ chối', async (t) => {
  const { app, call, base } = await start();
  t.after(() => app.server.close());
  assert.equal((await call('POST', '/api/projects', { body: { name: 'x' } })).status, 403);
  assert.equal((await call('POST', '/api/projects', { body: { name: 'x' }, headers: { 'x-phong-chat': '1' } })).status, 200);
  const status = await new Promise((resolve, reject) => {
    const u = new URL(`${base}/api/state`);
    require('node:http').get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 421);
  const openapi = await fetch(`${base}/v1/openapi.json`);
  assert.equal(openapi.status, 200);
});
