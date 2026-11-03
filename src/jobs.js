'use strict';
// Chạy lệnh đăng nhập / cài đặt CHÍNH THỨC của từng CLI từ nút bấm trên giao diện.
// Ứng dụng không đọc, không lưu token: CLI tự lưu thông tin đăng nhập của nó như khi bạn chạy trong Terminal.
const { spawn, execFile } = require('node:child_process');
const os = require('node:os');
const { findOnPath } = require('./adapters/cli');
const { safeEnv } = require('./adapters/base');
const { newId } = require('./store');

const IS_WIN = process.platform === 'win32';

// Lệnh theo preset. Chỉ các lệnh cố định này mới được chạy; giao diện không gửi được lệnh tùy ý.
const COMMANDS = {
  codex: {
    status: ['login', 'status'],
    login: ['login'],
    loginDevice: ['login', '--device-auth'],
    install: ['npm', ['install', '-g', '@openai/codex']],
    loginHint: 'Liên kết đăng nhập sẽ hiện bên dưới. Chọn "Sign in with ChatGPT". Không chọn đăng nhập bằng API key nếu không muốn trả phí.',
  },
  claude: {
    status: ['auth', 'status', '--json'],
    login: ['auth', 'login', '--claudeai'],
    install: ['npm', ['install', '-g', '@anthropic-ai/claude-code']],
    loginHint: 'Mở liên kết hiện bên dưới, đăng nhập tài khoản Claude Pro/Max. Nếu trang trả về một mã, dán mã vào ô bên dưới rồi bấm Gửi.',
  },
};

const redact = (s) => String(s)
  .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-••••')
  .replace(/(api[_-]?key|token)(["':=\s]+)[A-Za-z0-9._-]{12,}/gi, '$1$2••••')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // bỏ mã màu terminal

function run(bin, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(bin, args, { env: safeEnv(), timeout: timeoutMs, cwd: os.homedir(), shell: IS_WIN, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: redact(`${stdout || ''}${stderr || ''}`).trim() });
    });
  });
}

// Kiểm tra trạng thái đăng nhập. Không gọi AI, không tốn hạn mức.
async function authStatus(agentCfg) {
  const c = COMMANDS[agentCfg.preset];
  if (!c) return { supported: false, message: 'Loại kết nối này không có lệnh kiểm tra đăng nhập.' };
  const bin = findOnPath(agentCfg.command || agentCfg.preset);
  if (!bin) return { supported: true, installed: false, loggedIn: false, message: `Chưa cài lệnh "${agentCfg.preset}".` };
  const r = await run(bin, c.status);
  if (agentCfg.preset === 'codex') {
    const loggedIn = /logged in/i.test(r.out) && !/not logged in/i.test(r.out);
    const viaApiKey = /api key/i.test(r.out);
    return {
      supported: true, installed: true, loggedIn, paid: loggedIn && viaApiKey,
      message: !loggedIn ? 'Chưa đăng nhập.' : viaApiKey
        ? 'Đang đăng nhập bằng API key: sẽ TÍNH PHÍ theo API. Hãy đăng nhập lại bằng tài khoản ChatGPT.'
        : 'Đã đăng nhập bằng tài khoản ChatGPT (dùng hạn mức gói).',
      raw: r.out.slice(0, 300),
    };
  }
  let j = null;
  try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch {}
  if (!j) return { supported: true, installed: true, loggedIn: false, message: 'Không đọc được trạng thái đăng nhập.', raw: r.out.slice(0, 300) };
  const method = String(j.authMethod || '');
  const paid = /api.?key|console/i.test(method);
  return {
    supported: true, installed: true, loggedIn: !!j.loggedIn, paid: !!j.loggedIn && paid,
    message: !j.loggedIn ? 'Chưa đăng nhập.' : paid
      ? `Đang đăng nhập kiểu "${method}": có thể TÍNH PHÍ theo API. Hãy đăng nhập lại bằng tài khoản Claude.`
      : `Đã đăng nhập (${method || 'tài khoản Claude'}).`,
  };
}

class Jobs {
  constructor() { this.jobs = new Map(); }

  start(agentCfg, kind) {
    const c = COMMANDS[agentCfg.preset];
    if (!c) throw new Error('Loại kết nối này không hỗ trợ thao tác từ giao diện');
    for (const j of this.jobs.values()) if (j.agentId === agentCfg.id && !j.done) throw new Error('Đang có một thao tác chạy cho AI này');
    let bin;
    let args;
    if (kind === 'install') {
      bin = findOnPath('npm');
      if (!bin) throw new Error('Không tìm thấy npm trên máy');
      [, args] = c.install;
    } else {
      bin = findOnPath(agentCfg.command || agentCfg.preset);
      if (!bin) throw new Error(`Chưa cài lệnh "${agentCfg.preset}". Bấm "Cài đặt" trước.`);
      args = kind === 'loginDevice' && c.loginDevice ? c.loginDevice : c.login;
    }
    const job = {
      id: newId('job'), agentId: agentCfg.id, kind, lines: [], done: false, exitCode: null,
      hint: kind === 'install' ? `Đang chạy: npm ${args.join(' ')}` : c.loginHint,
      command: kind === 'install' ? `npm ${args.join(' ')}` : `${agentCfg.preset} ${args.join(' ')}`,
      startedAt: Date.now(),
    };
    const child = spawn(bin, args, {
      cwd: os.homedir(), env: safeEnv({ NO_COLOR: '1', FORCE_COLOR: '0' }), shell: IS_WIN, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const push = (chunk) => {
      for (const line of redact(chunk).split(/\r?\n/)) {
        if (line.trim()) job.lines.push(line.slice(0, 500));
      }
      if (job.lines.length > 300) job.lines.splice(0, job.lines.length - 300);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => { push(`Lỗi: ${e.message}`); job.done = true; job.exitCode = -1; });
    child.on('close', (code) => { job.done = true; job.exitCode = code; });
    const timer = setTimeout(() => { if (!job.done) { push('Hết thời gian (10 phút), đã dừng.'); child.kill(); } }, 10 * 60 * 1000);
    timer.unref();
    job.child = child;
    this.jobs.set(job.id, job);
    return this.view(job);
  }

  view(job) {
    const { id, agentId, kind, lines, done, exitCode, hint, command } = job;
    return { id, agentId, kind, lines, done, exitCode, hint, command };
  }

  get(id) { const j = this.jobs.get(id); return j ? this.view(j) : null; }

  input(id, text) {
    const j = this.jobs.get(id);
    if (!j || j.done) return false;
    j.child.stdin.write(`${String(text).slice(0, 2000)}\n`);
    j.lines.push('(đã gửi nội dung bạn nhập)');
    return true;
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j || j.done) return false;
    j.child.kill();
    return true;
  }
}

module.exports = { Jobs, authStatus, COMMANDS };
