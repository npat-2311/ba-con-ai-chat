'use strict';
// Lưu trữ cục bộ bằng một file JSON. Đủ cho nhu cầu cá nhân, không cần cơ sở dữ liệu.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({
  version: 1,
  projects: [],
  conversations: [],
  messages: [],
  sessions: [],
  idempotency: [],
  agentState: {},
});

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.timer = null;
    if (file && fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = Object.assign(EMPTY(), raw);
    }
  }

  // Khi khởi động lại: không tự chạy tiếp phiên cũ.
  recoverAfterRestart() {
    let changed = false;
    for (const s of this.data.sessions) {
      if (['running', 'stopping', 'synthesizing'].includes(s.status)) {
        s.status = 'stopped';
        s.stopReason = 'Ứng dụng đã khởi động lại; phiên không tự chạy tiếp.';
        s.endedAt = new Date().toISOString();
        changed = true;
      }
    }
    for (const m of this.data.messages) {
      if (['waiting', 'streaming'].includes(m.status)) {
        m.status = 'cancelled';
        changed = true;
      }
    }
    if (changed) this.saveNow();
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    if (!this.file) return;
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ---- Truy vấn tiện dụng ----
  project(id) { return this.data.projects.find((p) => p.id === id); }
  conversation(id) { return this.data.conversations.find((c) => c.id === id); }
  message(id) { return this.data.messages.find((m) => m.id === id); }
  session(id) { return this.data.sessions.find((s) => s.id === id); }
  messagesOf(conversationId) { return this.data.messages.filter((m) => m.conversationId === conversationId); }
  sessionsOf(conversationId) { return this.data.sessions.filter((s) => s.conversationId === conversationId); }

  createProject({ name, description = '', goal = '', instructions = '' }) {
    const now = new Date().toISOString();
    const p = { id: newId('prj'), name: String(name || 'Dự án mới').slice(0, 200), description, goal, instructions, pinned: false, archived: false, createdAt: now, updatedAt: now };
    this.data.projects.push(p);
    this.save();
    return p;
  }

  createConversation({ title, projectId = null, participants, maxRounds = 3 }) {
    const now = new Date().toISOString();
    const c = {
      id: newId('cnv'),
      projectId: projectId || null,
      title: String(title || 'Cuộc trò chuyện mới').slice(0, 200),
      pinned: false,
      archived: false,
      settings: { maxRounds, participants: participants || null },
      summary: { text: '', upToMessageId: null, updatedAt: null },
      createdAt: now,
      updatedAt: now,
    };
    this.data.conversations.push(c);
    this.save();
    return c;
  }

  addMessage(fields) {
    const m = Object.assign({
      id: newId('msg'),
      createdAt: new Date().toISOString(),
      pinned: false,
      status: 'done',
      content: '',
      kind: 'discussion',
    }, fields);
    this.data.messages.push(m);
    const c = this.conversation(m.conversationId);
    if (c) c.updatedAt = m.createdAt;
    this.save();
    return m;
  }

  deleteConversation(id) {
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    this.data.messages = this.data.messages.filter((m) => m.conversationId !== id);
    this.data.sessions = this.data.sessions.filter((s) => s.conversationId !== id);
    this.save();
  }

  // mode: 'delete' xóa luôn các cuộc trò chuyện; 'detach' chuyển chúng ra "Chưa thuộc dự án".
  deleteProject(id, mode) {
    const convs = this.data.conversations.filter((c) => c.projectId === id);
    if (mode === 'delete') convs.forEach((c) => this.deleteConversation(c.id));
    else convs.forEach((c) => { c.projectId = null; });
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    this.save();
    return convs.length;
  }
}

module.exports = { Store, newId };
