'use strict';
// Model: gợi ý, tải danh sách từ máy chủ GIẢ LẬP kiểu Gemini API, và gửi lại khi model không nhận tham số suy nghĩ.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listModels, suggestionsFor } = require('../src/models');
const { GeminiApiAdapter } = require('../src/adapters/http');

function fakeGemini(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/v1beta` }));
  });
}

test('Gợi ý model mặc định không còn gemini-2.5-flash', () => {
  const ids = suggestionsFor({ type: 'gemini-api' }).models.map((m) => m.id);
  assert.ok(ids.includes('gemini-3.8-flash'));
  assert.ok(!ids.includes('gemini-2.5-flash'));
  assert.equal(require('../config.example.json').agents.find((a) => a.id === 'gemini').model, 'gemini-3.8-flash');
  assert.ok(suggestionsFor({ type: 'cli', preset: 'claude' }).models.some((m) => m.id === 'sonnet'));
  assert.ok(suggestionsFor({ type: 'cli', preset: 'codex' }).efforts.length > 0);
});

test('Tải danh sách model Gemini: chỉ giữ model tạo văn bản', async (t) => {
  const { srv, base } = await fakeGemini((req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'k');
    res.end(JSON.stringify({ models: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'], displayName: 'Flash' },
      { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
    ] }));
  });
  t.after(() => srv.close());
  const r = await listModels({ type: 'gemini-api', apiKey: 'k', baseUrl: base });
  assert.deepEqual(r.map((m) => m.id), ['gemini-3.8-flash']);
});

test('Gemini: model không nhận thinkingLevel thì gửi lại đúng một lần không kèm', async (t) => {
  const bodies = [];
  const { srv, base } = await fakeGemini((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b);
      bodies.push(j);
      if (j.generationConfig.thinkingConfig) { res.statusCode = 400; return res.end('{"error":{"message":"thinking_level is not supported"}}'); }
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"candidates":[{"content":{"parts":[{"text":"Xin chào"}]}}]}\n\n');
    });
  });
  t.after(() => srv.close());
  const a = new GeminiApiAdapter({ id: 'g', model: 'm', apiKey: 'k', baseUrl: base });
  const r = await a.call({ system: 's', prompt: 'p', maxOutputTokens: 100 });
  assert.equal(r.text, 'Xin chào');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(bodies[1].generationConfig.maxOutputTokens, 100);
});
