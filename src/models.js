'use strict';
// Gợi ý model theo tài liệu chính thức (cập nhật 03/11/2026) và tải danh sách model thật khi nhà cung cấp hỗ trợ.
// Tải danh sách model KHÔNG tạo nội dung nên không tốn lượt tạo câu trả lời.

const SUGGESTIONS = {
  // https://ai.google.dev/gemini-api/docs/models · bậc miễn phí theo https://ai.google.dev/gemini-api/docs/pricing
  'gemini-api': [
    { id: 'gemini-3.8-flash', note: 'Khuyên dùng · miễn phí' },
    { id: 'gemini-3.6-flash', note: 'Đời trước · miễn phí' },
    { id: 'gemini-3.5-flash-lite', note: 'Nhanh, tiết kiệm · miễn phí' },
    { id: 'gemini-3.1-flash-lite', note: 'Nhẹ nhất · miễn phí' },
    { id: 'gemini-4-argon', note: 'Mạnh nhất · KHÔNG có bậc miễn phí, cần bật thanh toán' },
  ],
  // https://developers.openai.com/codex/models
  codex: [
    { id: '', note: 'Mặc định của gói ChatGPT' },
    { id: 'gpt-6-luna', note: 'Tiết kiệm hạn mức nhất' },
    { id: 'gpt-6.1-sol', note: 'Cân bằng · khuyên dùng' },
    { id: 'gpt-6.1-terra', note: 'Nhanh' },
    { id: 'gpt-6-astra', note: 'Mạnh nhất · tốn hạn mức nhanh nhất' },
  ],
  // https://code.claude.com/docs/en/model-config
  claude: [
    { id: 'haiku', note: 'Tiết kiệm hạn mức nhất' },
    { id: 'sonnet', note: 'Cân bằng · khuyên dùng' },
    { id: 'opus', note: 'Mạnh · tốn hạn mức nhanh' },
    { id: 'fable', note: 'Mạnh nhất · tốn hạn mức nhanh nhất' },
    { id: '', note: 'Mặc định của tài khoản' },
  ],
};

const EFFORT = {
  codex: [
    { id: 'low', note: 'Thấp · tiết kiệm (mặc định)' },
    { id: 'medium', note: 'Vừa' },
    { id: 'high', note: 'Cao · tốn hạn mức' },
  ],
};

function suggestionsFor(a) {
  const key = a.type === 'cli' ? a.preset : a.type;
  return { models: SUGGESTIONS[key] || [], efforts: EFFORT[key] || [] };
}

function keyFrom(a) {
  if (a.apiKey) return a.apiKey;
  if (a.apiKeyEnv && process.env[a.apiKeyEnv]) return process.env[a.apiKeyEnv];
  return '';
}

// Danh sách model thật từ nhà cung cấp (Gemini API, endpoint tương thích OpenAI).
async function listModels(a) {
  const signal = AbortSignal.timeout(15000);
  if (a.type === 'gemini-api') {
    const key = keyFrom(a);
    if (!key) throw new Error('Cần lưu API key Gemini trước');
    const base = a.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${base}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal });
    if (!res.ok) throw new Error(`Gemini API trả về HTTP ${res.status}`);
    const j = await res.json();
    const known = new Map(SUGGESTIONS['gemini-api'].map((m) => [m.id, m.note]));
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name)
        && !/(image|tts|audio|live|embedding|robotics|computer)/i.test(m.name))
      .map((m) => {
        const id = m.name.replace(/^models\//, '');
        return { id, note: known.get(id) || m.displayName || '' };
      });
  }
  if (a.type === 'openai-compat') {
    const headers = {};
    const key = keyFrom(a);
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${String(a.baseUrl).replace(/\/$/, '')}/models`, { headers, signal });
    if (!res.ok) throw new Error(`Endpoint trả về HTTP ${res.status}`);
    const j = await res.json();
    return (j.data || []).map((m) => ({ id: String(m.id), note: '' }));
  }
  throw new Error('Loại kết nối này không có danh sách model để tải; hãy chọn trong gợi ý hoặc tự nhập');
}

module.exports = { suggestionsFor, listModels, SUGGESTIONS };
