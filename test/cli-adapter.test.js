'use strict';
// Kiểm tra bộ đọc đầu ra của adapter CLI bằng script GIẢ LẬP in ra sự kiện mẫu theo tài liệu.
// Không chạy CLI thật. Định dạng thật vẫn cần xác minh bằng một lượt gọi trên máy người dùng.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CliAdapter } = require('../src/adapters/cli');

function fakeBin(dir, name, lines, { exit = 0, stderr = '' } = {}) {
  const file = path.join(dir, name);
  const out = lines.map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(file, `#!/usr/bin/env node
let input=''; process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>{
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) { console.log(JSON.stringify({type:'error',message:'paid key leaked'})); process.exit(1); }
  process.stdout.write(${JSON.stringify(out)} + '\\n'); ${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''} process.exit(${exit}); });
`, { mode: 0o755 });
  return file;
}

test('preset claude: stream-json từng đoạn và kết quả cuối', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecli-'));
  const bin = fakeBin(dir, 'claude', [
    { type: 'system', subtype: 'init' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Xin ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chào' } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Xin chào', usage: { input_tokens: 10, output_tokens: 3 } },
  ]);
  process.env.ANTHROPIC_API_KEY = 'should-not-leak';
  const a = new CliAdapter({ id: 'claude', preset: 'claude', command: bin });
  const deltas = [];
  const r = await a.call({ system: 's', prompt: 'p', onDelta: (d) => deltas.push(d) });
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(r.text, 'Xin chào');
  assert.deepEqual(deltas, ['Xin ', 'chào']);
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 3 });
});

test('preset codex: JSONL item.completed và lỗi hết hạn mức', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecli-'));
  const ok = fakeBin(dir, 'codex', [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'i', type: 'reasoning', text: 'nghĩ' } },
    { type: 'item.completed', item: { id: 'j', type: 'agent_message', text: 'Trả lời' } },
    { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } },
  ]);
  const r = await new CliAdapter({ id: 'chatgpt', preset: 'codex', command: ok }).call({ system: 's', prompt: 'p' });
  assert.equal(r.text, 'Trả lời');
  const bad = fakeBin(path.join(dir), 'codex2', [{ type: 'turn.failed', error: { message: "You've hit your usage limit" } }], { exit: 1 });
  await assert.rejects(new CliAdapter({ id: 'c', preset: 'codex', command: bad }).call({ system: 's', prompt: 'p' }), (e) => e.code === 'quota');
});

test('CLI không có trên máy thì hiện Chưa kết nối', () => {
  const a = new CliAdapter({ id: 'x', preset: 'codex', command: 'lenh-khong-ton-tai-123' });
  assert.equal(a.isConfigured().ok, false);
});
