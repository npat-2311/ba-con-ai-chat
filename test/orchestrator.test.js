'use strict';
// Kiểm tra bộ điều phối bằng adapter GIẢ LẬP (không gọi AI thật, không tốn hạn mức).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { buildAdapters } = require('../src/adapters');
const { Orchestrator } = require('../src/orchestrator');

function setup(agents, limits) {
  const store = new Store(null);
  const adapters = buildAdapters(agents);
  const orch = new Orchestrator(store, adapters, Object.assign({ callTimeoutSec: 5 }, limits));
  const conv = store.createConversation({ title: 't' });
  const byId = Object.fromEntries(adapters.map((a) => [a.id, a]));
  return { store, orch, conv, byId };
}
const three = (extra = {}) => ['gemini', 'chatgpt', 'claude'].map((id) => Object.assign({ id, name: id, type: 'mock', delayMs: 5 }, extra[id] || {}));
const wait = (orch, s) => orch.loops.get(s.id);
const agentMsgs = (store, s) => store.data.messages.filter((m) => m.sessionId === s.id && m.role === 'agent');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('một tin nhắn kích hoạt tất cả AI đang bật và đã kết nối; AI chưa kết nối bị bỏ qua', async () => {
  const agents = [...three(), { id: 'gem-api', name: 'Gemini API', type: 'gemini-api', model: 'x', apiKeyEnv: 'KHONG_CO_BIEN_NAY' }];
  const { store, orch, conv } = setup(agents);
  assert.equal(orch.agents().find((a) => a.id === 'gem-api').status, 'not_connected');
  const s = orch.startSession({ conversationId: conv.id, text: 'Chào', maxRounds: 1 });
  await wait(orch, s);
  assert.deepEqual(s.participants, ['gemini', 'chatgpt', 'claude']);
  assert.deepEqual(agentMsgs(store, s).map((m) => m.agentId).sort(), ['chatgpt', 'claude', 'gemini']);
  assert.equal(s.calls.total, 3);
  assert.equal(s.status, 'done');
});

test('vòng sau thực sự dùng phản hồi của vòng trước', async () => {
  const { store, orch, conv, byId } = setup(three());
  const s = orch.startSession({ conversationId: conv.id, text: 'Ý tưởng?', maxRounds: 2 });
  await wait(orch, s);
  const p2 = byId.claude.calls[1].prompt;
  assert.match(p2, /\[PHẢN HỒI VÒNG 1\]/);
  assert.match(p2, /### gemini \(giả lập\)/);
  assert.match(p2, /\[gemini \(giả lập\)\] vòng 1/);
  assert.doesNotMatch(byId.claude.calls[0].prompt, /PHẢN HỒI VÒNG/); // vòng 1 không có tin chưa tồn tại
  const r2 = agentMsgs(store, s).filter((m) => m.round === 2);
  assert.equal(r2.length, 3);
  assert.ok(r2.every((m) => /Đã đọc vòng 1/.test(m.content)));
  assert.ok(r2.every((m) => !/TRANG_THAI/.test(m.content)), 'metadata trạng thái phải bị ẩn');
});

test('số vòng tối đa chỉ nhận số nguyên 1–100', () => {
  const { orch, conv } = setup(three());
  for (const bad of [0, 101, 2.5, -1, 'abc', null, '']) {
    assert.throws(() => orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: bad === null ? 'null' : bad }), /1 đến 100/);
  }
  for (const ok of [1, 100, '7']) {
    const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: ok });
    assert.equal(s.maxRounds, Number(ok));
    orch.stop(s.id);
  }
});

test('Dừng: không tạo vòng mới, giữ phản hồi đã nhận, phản hồi đến muộn bị bỏ qua', async () => {
  const { store, orch, conv } = setup(three({ claude: { delayMs: 300, ignoreAbort: true } }));
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 10 });
  await sleep(60);
  orch.stop(s.id);
  await wait(orch, s);
  await sleep(400); // chờ phản hồi đến muộn của claude
  const msgs = agentMsgs(store, s);
  assert.equal(s.status, 'stopped');
  assert.equal(s.round, 1);
  assert.equal(msgs.filter((m) => m.status === 'done').length, 2);
  const late = msgs.find((m) => m.agentId === 'claude');
  assert.equal(late.status, 'cancelled');
  assert.equal(late.content, '');
});

test('Tin mới khi đang thảo luận: phiên cũ dừng, phản hồi muộn không lọt vào phiên mới', async () => {
  const { store, orch, conv } = setup(three({ chatgpt: { delayMs: 250, ignoreAbort: true } }));
  const s1 = orch.startSession({ conversationId: conv.id, text: 'cũ', maxRounds: 5 });
  await sleep(40);
  const s2 = orch.startSession({ conversationId: conv.id, text: 'mới', maxRounds: 1 });
  assert.notEqual(s1.id, s2.id);
  await wait(orch, s1);
  await wait(orch, s2);
  await sleep(300);
  assert.equal(s1.status, 'stopped');
  assert.match(s1.stopReason, /tin nhắn mới/);
  const m2 = agentMsgs(store, s2);
  assert.ok(m2.every((m) => m.sessionId === s2.id));
  assert.equal(agentMsgs(store, s1).find((m) => m.agentId === 'chatgpt').status, 'cancelled');
});

test('Dừng sớm khi các bên đã thống nhất', async () => {
  const { orch, conv } = setup(three({ gemini: { agreeFromRound: 2 }, chatgpt: { agreeFromRound: 2 }, claude: { skipFromRound: 2 } }));
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 10 });
  await wait(orch, s);
  assert.equal(s.round, 2);
  assert.match(s.stopReason, /Dừng sớm/);
});

test('Một câu "đồng ý" của một AI không đủ để dừng', async () => {
  const { orch, conv } = setup(three({ gemini: { agreeFromRound: 2 } }));
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 4 });
  await wait(orch, s);
  assert.equal(s.round, 4);
});

test('Lỗi một AI không làm treo hay lặp; AI lỗi xác thực bị ngừng dùng', async () => {
  const { store, orch, conv } = setup(three({ chatgpt: { fail: 'auth' } }));
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 3 });
  await wait(orch, s);
  assert.equal(s.status, 'done');
  assert.equal(s.round, 3);
  assert.equal(s.calls.byAgent.chatgpt, 1, 'không thử lại AI đã lỗi xác thực');
  assert.equal(orch.agents().find((a) => a.id === 'chatgpt').status, 'error');
  assert.match(agentMsgs(store, s).find((m) => m.agentId === 'chatgpt').error, /xác thực/);
});

test('Tất cả AI lỗi thì phiên kết thúc, không vòng lặp', async () => {
  const { orch, conv } = setup(three({ gemini: { fail: 'error' }, chatgpt: { fail: 'error' }, claude: { fail: 'error' } }));
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 50 });
  await wait(orch, s);
  assert.equal(s.status, 'error');
  assert.equal(s.round, 1);
  assert.equal(s.calls.total, 3);
});

test('Hết thời gian chờ được báo lỗi rõ ràng', async () => {
  const { store, orch, conv } = setup(three({ claude: { delayMs: 3000 } }), { callTimeoutSec: 0.2 });
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 1 });
  await wait(orch, s);
  assert.match(agentMsgs(store, s).find((m) => m.agentId === 'claude').error, /Hết thời gian/);
});

test('Giảm số vòng khi đang chạy: hoàn tất vòng hiện tại rồi dừng', async () => {
  const { orch, conv } = setup(three({ gemini: { delayMs: 80 } }));
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 10 });
  await sleep(120); // đang ở vòng 2
  const cur = s.round;
  orch.setMaxRounds(s.id, 1);
  await wait(orch, s);
  assert.equal(s.round, cur);
  assert.equal(s.status, 'done');
});

test('Thảo luận tiếp chạy đúng một vòng và không vượt 100', async () => {
  const { orch, conv } = setup(three());
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 2 });
  await wait(orch, s);
  orch.continueSession(s.id);
  await wait(orch, s);
  assert.equal(s.round, 3);
  s.round = 100;
  assert.throws(() => orch.continueSession(s.id), /100 vòng/);
});

test('Chốt ý dùng đúng một AI và được tính vào bộ đếm', async () => {
  const { store, orch, conv } = setup(three());
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 1 });
  await wait(orch, s);
  const before = s.calls.total;
  orch.synthesize(s.id);
  await wait(orch, s);
  assert.equal(s.calls.total, before + 1);
  const syn = store.data.messages.filter((m) => m.kind === 'synthesis');
  assert.equal(syn.length, 1);
  assert.equal(syn[0].agentId, 'claude');
  assert.match(syn[0].content, /Kết luận/);
  assert.equal(conv.summary.text, syn[0].content, 'bản chốt ý dùng làm tóm tắt chung');
});

test('Chốt ý khi đang chạy: không thêm vòng tranh luận', async () => {
  const { orch, conv } = setup(three({ gemini: { delayMs: 60 } }));
  const s = orch.startSession({ conversationId: conv.id, text: 'x', maxRounds: 20 });
  await sleep(20);
  orch.synthesize(s.id);
  await wait(orch, s);
  assert.equal(s.round, 1);
  assert.equal(s.calls.total, 4);
  assert.equal(s.stopReason, 'Đã chốt ý');
});

test('Ngữ cảnh: có tin ghim và mục tiêu dự án, không trộn dự án khác, không gửi toàn bộ lịch sử', async () => {
  const { store, orch, byId } = setup(three());
  const pA = store.createProject({ name: 'A', goal: 'MỤC-TIÊU-A' });
  const pB = store.createProject({ name: 'B', goal: 'MỤC-TIÊU-B' });
  const a1 = store.createConversation({ title: 'a1', projectId: pA.id });
  const a2 = store.createConversation({ title: 'a2', projectId: pA.id });
  const b1 = store.createConversation({ title: 'b1', projectId: pB.id });
  store.addMessage({ conversationId: a1.id, role: 'user', content: 'GHIM-A1', pinned: true });
  store.addMessage({ conversationId: a1.id, role: 'user', content: 'KHONG-GHIM-A1' });
  store.addMessage({ conversationId: b1.id, role: 'user', content: 'GHIM-B1', pinned: true });
  for (let i = 0; i < 30; i++) store.addMessage({ conversationId: a2.id, role: 'user', content: `cũ-${i}` });
  const s = orch.startSession({ conversationId: a2.id, text: 'hỏi', maxRounds: 1 });
  await wait(orch, s);
  const p = byId.gemini.calls[0].prompt;
  assert.match(p, /MỤC-TIÊU-A/);
  assert.match(p, /GHIM-A1/);
  assert.doesNotMatch(p, /KHONG-GHIM-A1/);
  assert.doesNotMatch(p, /MỤC-TIÊU-B|GHIM-B1/);
  assert.doesNotMatch(p, /cũ-0\b/);
  assert.match(p, /cũ-29/);
});

test('Lưu và khôi phục dữ liệu; mở lại không tự chạy phiên cũ', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-')), 'db.json');
  const st = new Store(file);
  const p = st.createProject({ name: 'Dự án X' });
  const c = st.createConversation({ title: 'c', projectId: p.id });
  st.addMessage({ conversationId: c.id, role: 'user', content: 'quan trọng', pinned: true });
  st.addMessage({ conversationId: c.id, role: 'agent', content: 'dở', status: 'streaming', sessionId: 's1' });
  st.data.sessions.push({ id: 's1', conversationId: c.id, status: 'running', round: 1, maxRounds: 3, calls: { total: 1, byAgent: {} } });
  p.pinned = true;
  st.saveNow();
  const st2 = new Store(file);
  st2.recoverAfterRestart();
  assert.equal(st2.data.projects[0].name, 'Dự án X');
  assert.equal(st2.data.projects[0].pinned, true);
  assert.equal(st2.data.messages[0].pinned, true);
  assert.equal(st2.data.sessions[0].status, 'stopped');
  assert.equal(st2.data.messages[1].status, 'cancelled');
});

test('Adapter CLI: loại bỏ khóa API trả phí khỏi môi trường tiến trình con', () => {
  const { safeEnv } = require('../src/adapters/base');
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'x';
  const env = safeEnv();
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

test('Adapter openai-compat chặn api.openai.com khi chưa được chấp thuận', () => {
  const [a] = buildAdapters([{ id: 'oa', type: 'openai-compat', baseUrl: 'https://api.openai.com/v1', model: 'x' }]);
  assert.equal(a.isConfigured().ok, false);
});
