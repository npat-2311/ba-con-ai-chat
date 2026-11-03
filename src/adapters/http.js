'use strict';
// Adapter HTTP: Gemini API (chính thức) và endpoint tương thích OpenAI Chat Completions (agent bên ngoài).
const { AdapterError, classifyError } = require('./base');

async function readSSE(res, onData) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      try { onData(JSON.parse(data)); } catch { /* bỏ qua dòng hỏng */ }
    }
  }
}

async function httpError(res, label) {
  let body = '';
  try { body = (await res.text()).slice(0, 400); } catch {}
  const msg = `${label} trả về HTTP ${res.status}: ${body}`;
  let code = classifyError(msg);
  if (res.status === 401 || res.status === 403) code = 'auth';
  if (res.status === 429) code = 'quota';
  return new AdapterError(code, msg);
}

function wrapFetchError(e) {
  if (e instanceof AdapterError) return e;
  if (e && e.name === 'AbortError') return new AdapterError('cancelled', 'Đã hủy');
  return new AdapterError('unavailable', `Không kết nối được: ${e && e.message}`);
}

function keyFrom(cfg) {
  if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) return process.env[cfg.apiKeyEnv];
  return cfg.apiKey || '';
}

// Gemini API: https://ai.google.dev/api/generate-content (streamGenerateContent?alt=sse)
class GeminiApiAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.type = 'gemini-api';
    this.capabilities = { streaming: true, cancel: true };
    this.costSource = cfg.costSource || 'Gemini API (bậc miễn phí nếu project chưa bật billing)';
  }

  isConfigured() {
    if (!keyFrom(this.cfg)) return { ok: false, detail: 'Chưa có API key Gemini' };
    if (!this.cfg.model) return { ok: false, detail: 'Chưa chọn model' };
    return { ok: true, detail: `Model ${this.cfg.model}` };
  }

  async call({ system, prompt, maxOutputTokens, signal, onDelta }) {
    const key = keyFrom(this.cfg);
    if (!key) throw new AdapterError('auth', 'Chưa có API key Gemini');
    const base = this.cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${base}/models/${encodeURIComponent(this.cfg.model)}:streamGenerateContent?alt=sse`;
    // Mặc định suy nghĩ ở mức thấp để tiết kiệm token (Gemini 3.x). Nếu model không nhận tham số này,
    // gửi lại đúng một lần không kèm nó (cùng model, cùng bậc miễn phí).
    const thinking = this.cfg.generationConfig ? null : { thinkingConfig: { thinkingLevel: this.cfg.thinkingLevel || 'low' } };
    const send = (withThinking) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Token suy nghĩ cũng tính vào maxOutputTokens, nên chừa thêm chỗ khi bật suy nghĩ.
        generationConfig: Object.assign({ maxOutputTokens: withThinking ? maxOutputTokens + 1024 : maxOutputTokens }, this.cfg.generationConfig || {}, withThinking ? thinking : {}),
      }),
      signal,
    });
    let res;
    try {
      res = await send(!!thinking);
      if (res.status === 400 && thinking) {
        const body = await res.text().catch(() => '');
        if (/thinking/i.test(body)) res = await send(false);
        else throw new AdapterError('error', `Gemini API trả về HTTP 400: ${body.slice(0, 300)}`);
      }
      if (!res.ok) throw await httpError(res, 'Gemini API');
      let text = '';
      let usage = null;
      await readSSE(res, (ev) => {
        const parts = (ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts) || [];
        for (const p of parts) {
          if (p.text && !p.thought) { text += p.text; onDelta && onDelta(p.text); }
        }
        if (ev.usageMetadata) usage = { inputTokens: ev.usageMetadata.promptTokenCount, outputTokens: ev.usageMetadata.candidatesTokenCount };
        if (ev.error) throw new AdapterError(classifyError(ev.error.message), ev.error.message);
      });
      if (!text.trim()) throw new AdapterError('error', 'Gemini không trả về nội dung');
      return { text, usage };
    } catch (e) {
      throw wrapFetchError(e);
    }
  }
}

// Endpoint tương thích OpenAI Chat Completions (ví dụ Ollama, LM Studio, agent tự viết).
// Chỉ dùng khi bạn đã kiểm tra endpoint đó thật sự tương thích. Không đồng nghĩa với dùng OpenAI API.
class OpenAICompatAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.type = 'openai-compat';
    this.capabilities = { streaming: cfg.stream !== false, cancel: true };
    this.costSource = cfg.costSource || 'Theo endpoint bạn cấu hình';
    if (/api\.openai\.com/i.test(cfg.baseUrl || '') && !cfg.allowPaidOpenAI) {
      this.blocked = 'Endpoint api.openai.com là API trả phí; cần đặt allowPaidOpenAI: true sau khi bạn chấp thuận.';
    }
  }

  isConfigured() {
    if (this.blocked) return { ok: false, detail: this.blocked };
    if (!this.cfg.baseUrl) return { ok: false, detail: 'Chưa khai báo baseUrl' };
    return { ok: true, detail: this.cfg.baseUrl };
  }

  async call({ system, prompt, maxOutputTokens, signal, onDelta }) {
    if (this.blocked) throw new AdapterError('unavailable', this.blocked);
    const headers = { 'content-type': 'application/json' };
    const key = keyFrom(this.cfg);
    if (key) headers.authorization = `Bearer ${key}`;
    const stream = this.capabilities.streaming;
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          max_tokens: maxOutputTokens,
          stream,
        }),
        signal,
      });
      if (!res.ok) throw await httpError(res, this.name);
      if (!stream) {
        const j = await res.json();
        const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        if (!text.trim()) throw new AdapterError('error', 'Không có nội dung trả lời');
        onDelta && onDelta(text);
        return { text, usage: j.usage ? { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens } : null };
      }
      let text = '';
      let usage = null;
      await readSSE(res, (ev) => {
        const d = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
        if (d) { text += d; onDelta && onDelta(d); }
        if (ev.usage) usage = { inputTokens: ev.usage.prompt_tokens, outputTokens: ev.usage.completion_tokens };
      });
      if (!text.trim()) throw new AdapterError('error', 'Không có nội dung trả lời');
      return { text, usage };
    } catch (e) {
      throw wrapFetchError(e);
    }
  }
}

module.exports = { GeminiApiAdapter, OpenAICompatAdapter, readSSE };
