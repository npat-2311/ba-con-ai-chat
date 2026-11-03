'use strict';
// Cài đặt chỉnh từ trình duyệt: bật/tắt AI, model, API key Gemini, agent ngoài, khóa API cho agent khác.
// Lưu ở data/settings.json (nằm trong .gitignore, quyền 600). Khóa bí mật không bao giờ được gửi xuống trình duyệt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({ agents: {}, customAgents: [], secrets: {}, apiKeys: [] });
const EDITABLE = ['disabled', 'model', 'name', 'baseUrl', 'reasoningEffort', 'stream'];

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

class Settings {
  constructor(file, baseAgents) {
    this.file = file;
    this.baseAgents = baseAgents || [];
    this.data = EMPTY();
    if (file && fs.existsSync(file)) this.data = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  isCustom(id) { return this.data.customAgents.some((a) => a.id === id); }

  // Cấu hình hiệu lực = config.json + chỉnh sửa trên giao diện + agent tự thêm. Chứa bí mật: chỉ dùng phía server.
  effectiveAgents() {
    const list = [...this.baseAgents, ...this.data.customAgents].map((a) => {
      const o = Object.assign({}, a, this.data.agents[a.id] || {});
      const sec = this.data.secrets[a.id];
      if (sec && sec.apiKey) o.apiKey = sec.apiKey;
      return o;
    });
    return list;
  }

  // Thông tin an toàn để hiển thị (không có bí mật).
  publicAgent(a) {
    const sec = this.data.secrets[a.id];
    const envKey = a.apiKeyEnv && process.env[a.apiKeyEnv];
    const key = (sec && sec.apiKey) || envKey || (a.apiKey && !/^THAY-/.test(a.apiKey) ? a.apiKey : '');
    return {
      id: a.id, name: a.name || a.id, type: a.type, preset: a.preset || null,
      disabled: !!a.disabled, model: a.model || '', baseUrl: a.baseUrl || '',
      reasoningEffort: a.reasoningEffort || '', custom: this.isCustom(a.id),
      needsKey: a.type === 'gemini-api' || a.type === 'openai-compat',
      hasKey: !!key, keyHint: key ? `••••${String(key).slice(-4)}` : '',
      keySource: sec && sec.apiKey ? 'giao diện' : envKey ? `biến môi trường ${a.apiKeyEnv}` : key ? 'config.json' : null,
    };
  }

  patchAgent(id, body) {
    const base = this.effectiveAgents().find((a) => a.id === id);
    if (!base) return null;
    const cur = this.data.agents[id] || {};
    for (const k of EDITABLE) {
      if (!(k in body)) continue;
      if (k === 'disabled' || k === 'stream') cur[k] = !!body[k];
      else cur[k] = String(body[k] ?? '').slice(0, 300).trim();
    }
    if (cur.baseUrl !== undefined && cur.baseUrl && !/^https?:\/\//i.test(cur.baseUrl)) throw new Error('baseUrl phải bắt đầu bằng http:// hoặc https://');
    this.data.agents[id] = cur;
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      this.data.secrets[id] = { apiKey: body.apiKey.trim().slice(0, 500), savedAt: new Date().toISOString() };
    }
    if (body.clearKey) delete this.data.secrets[id];
    this.save();
    return true;
  }

  addCustomAgent(body) {
    const name = String(body.name || '').trim().slice(0, 80);
    const baseUrl = String(body.baseUrl || '').trim();
    if (!name) throw new Error('Cần tên agent');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl phải bắt đầu bằng http:// hoặc https://');
    let id = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'agent';
    const taken = new Set(this.effectiveAgents().map((a) => a.id));
    let n = 2;
    const root = id;
    while (taken.has(id)) id = `${root}-${n++}`;
    this.data.customAgents.push({
      id, name, type: 'openai-compat', baseUrl, model: String(body.model || '').trim().slice(0, 200),
      stream: body.stream !== false, costSource: 'Theo endpoint bạn cấu hình',
    });
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) this.data.secrets[id] = { apiKey: body.apiKey.trim(), savedAt: new Date().toISOString() };
    this.save();
    return id;
  }

  removeCustomAgent(id) {
    if (!this.isCustom(id)) return false;
    this.data.customAgents = this.data.customAgents.filter((a) => a.id !== id);
    delete this.data.agents[id];
    delete this.data.secrets[id];
    this.save();
    return true;
  }

  // ---- Khóa API cho agent khác: chỉ lưu mã băm, khóa gốc chỉ hiện một lần ----
  createApiKey({ name, scopes, projects }) {
    const id = String(name || '').trim().slice(0, 60) || `khoa-${this.data.apiKeys.length + 1}`;
    if (this.data.apiKeys.some((k) => k.id === id)) throw new Error('Tên khóa đã tồn tại');
    const okScopes = (Array.isArray(scopes) ? scopes : []).filter((s) => ['read', 'write', 'control'].includes(s));
    if (!okScopes.length) throw new Error('Chọn ít nhất một quyền');
    const key = `pc_${crypto.randomBytes(24).toString('base64url')}`;
    this.data.apiKeys.push({
      id, hash: hash(key), hint: key.slice(-4), scopes: okScopes,
      projects: Array.isArray(projects) && projects.length ? projects.map(String) : ['*'],
      maxConcurrentSessions: 1, requestsPerMinute: 30, createdAt: new Date().toISOString(),
    });
    this.save();
    return { id, key };
  }

  revokeApiKey(id) {
    const before = this.data.apiKeys.length;
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.id !== id);
    this.save();
    return this.data.apiKeys.length < before;
  }

  publicApiKeys() {
    return this.data.apiKeys.map(({ id, hint, scopes, projects, createdAt }) => ({ id, hint: `••••${hint}`, scopes, projects, createdAt }));
  }
}

module.exports = { Settings, hash };
