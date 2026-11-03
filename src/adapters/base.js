'use strict';
// Giao diện chung cho mọi adapter (AI hoặc agent bên ngoài).
//
//   adapter.id, adapter.name, adapter.type
//   adapter.capabilities = { streaming: bool, cancel: bool }
//   adapter.isConfigured() -> { ok: bool, detail: string }     // KHÔNG gọi AI
//   adapter.call({ system, prompt, maxOutputTokens, signal, onDelta }) -> Promise<{ text, usage }>
//       usage (tùy chọn): { inputTokens, outputTokens }  — chỉ khi nhà cung cấp trả về số liệu
//       Lỗi ném ra là AdapterError với code: auth | quota | timeout | cancelled | unavailable | error

class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Phân loại lỗi theo nội dung thông báo để biết có nên ngừng dùng kết nối này không.
function classifyError(text) {
  const t = String(text || '').toLowerCase();
  if (/(usage limit|rate.?limit|quota|resource_exhausted|429|too many requests|limit reached|hết hạn mức|credit balance)/.test(t)) return 'quota';
  if (/(unauthori[sz]ed|401|403|not logged in|please log ?in|login required|authentication|invalid api key|api key not valid|permission_denied|credentials?)/.test(t)) return 'auth';
  return 'error';
}

// Biến môi trường chứa khóa API trả phí bị loại bỏ khỏi tiến trình CLI,
// để CLI không âm thầm chuyển sang thanh toán theo API.
const PAID_KEY_VARS = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS',
  'PHONG_CHAT_UI_PASSWORD',
];

function safeEnv(extra) {
  const env = { ...process.env };
  for (const k of PAID_KEY_VARS) delete env[k];
  return Object.assign(env, extra || {});
}

module.exports = { AdapterError, classifyError, safeEnv, PAID_KEY_VARS };
