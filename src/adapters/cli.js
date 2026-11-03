'use strict';
// Adapter chạy một CLI chính thức đã cài và đã đăng nhập trên máy (Codex CLI, Claude Code, Antigravity CLI...).
// Mỗi lượt gọi là một tiến trình riêng, chạy trong thư mục tạm trống, không có khóa API trả phí trong môi trường.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdapterError, classifyError, safeEnv } = require('./base');

const IS_WIN = process.platform === 'win32';

function findOnPath(bin) {
  if (path.isAbsolute(bin)) return fs.existsSync(bin) ? bin : null;
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext.toLowerCase());
      const P = path.join(dir, bin + ext);
      if (dir && fs.existsSync(p)) return p;
      if (dir && fs.existsSync(P)) return P;
    }
  }
  return null;
}

function parseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// ---- Các preset: dựng tham số và đọc đầu ra JSONL của từng CLI ----
const PRESETS = {
  // Codex CLI (ChatGPT). Tài liệu: https://developers.openai.com/codex/noninteractive
  codex: {
    bin: 'codex',
    streaming: false, // stdout chỉ có sự kiện JSONL; nội dung đến khi xong lượt
    promptVia: 'stdin',
    args(cfg) {
      const a = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-rules'];
      if (cfg.model) a.push('-m', cfg.model);
      if (cfg.reasoningEffort) a.push('-c', `model_reasoning_effort="${cfg.reasoningEffort}"`);
      a.push('-');
      return a;
    },
    systemInArgs: false,
    onEvent(ev, st) {
      if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) {
        st.text = st.text ? `${st.text}\n\n${ev.item.text}` : ev.item.text;
        st.delta(ev.item.text);
      } else if (ev.type === 'turn.completed' && ev.usage) {
        st.usage = { inputTokens: ev.usage.input_tokens, outputTokens: ev.usage.output_tokens };
      } else if (ev.type === 'turn.failed') {
        st.error = (ev.error && ev.error.message) || 'turn.failed';
      } else if (ev.type === 'error') {
        st.error = ev.message || 'error';
      }
    },
  },

  // Claude Code CLI. Tài liệu: https://code.claude.com/docs/en/headless
  claude: {
    bin: 'claude',
    streaming: true,
    promptVia: 'stdin',
    args(cfg, system) {
      const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands',
        '--max-turns', '1', '--system-prompt', system];
      if (cfg.model) a.push('--model', cfg.model);
      return a;
    },
    systemInArgs: true,
    onEvent(ev, st) {
      if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta'
        && ev.event.delta && ev.event.delta.type === 'text_delta') {
        st.text += ev.event.delta.text;
        st.delta(ev.event.delta.text);
      } else if (ev.type === 'result') {
        if (ev.is_error) st.error = ev.result || ev.subtype || 'Claude Code báo lỗi';
        else if (typeof ev.result === 'string' && ev.result.length >= st.text.length) st.text = ev.result;
        if (ev.usage) st.usage = { inputTokens: ev.usage.input_tokens, outputTokens: ev.usage.output_tokens };
      }
    },
  },

  // Antigravity CLI (Google). Tài liệu: https://antigravity.google/docs/cli/headless/
  // CHƯA XÁC MINH định dạng sự kiện; giả định giống Gemini CLI (message/result).
  agy: {
    bin: 'agy',
    streaming: true,
    promptVia: 'arg',
    args(cfg, system, prompt) {
      const a = ['-p', `${system}\n\n${prompt}`, '--output-format', 'stream-json'];
      if (cfg.model) a.push('--model', cfg.model);
      return a;
    },
    systemInArgs: true,
    onEvent(ev, st) {
      if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
        st.text += ev.content;
        st.delta(ev.content);
      } else if (ev.type === 'error') {
        st.error = ev.message || 'error';
      } else if (ev.type === 'result' && ev.status && ev.status !== 'success') {
        st.error = (ev.error && ev.error.message) || ev.status;
      }
    },
  },

  // Lệnh tùy chỉnh: in văn bản thuần ra stdout, nhận prompt qua stdin.
  text: {
    bin: null,
    streaming: true,
    promptVia: 'stdin',
    args(cfg) { return (cfg.args || []).map((x) => String(x).replace('{model}', cfg.model || '')); },
    systemInArgs: false,
    raw: true,
  },
};

function quoteWin(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^%]/.test(a)) return a;
  return `"${a.replace(/"/g, '""')}"`;
}

class CliAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.type = 'cli';
    this.preset = PRESETS[cfg.preset];
    if (!this.preset) throw new Error(`Preset CLI không hợp lệ: ${cfg.preset}`);
    this.bin = cfg.command || this.preset.bin;
    this.capabilities = { streaming: !!this.preset.streaming, cancel: true };
    this.costSource = cfg.costSource || 'Hạn mức thuê bao (qua CLI chính thức)';
  }

  isConfigured() {
    if (!this.bin) return { ok: false, detail: 'Chưa khai báo lệnh' };
    const found = findOnPath(this.bin);
    return found ? { ok: true, detail: `Đã tìm thấy lệnh ${this.bin}` } : { ok: false, detail: `Không tìm thấy lệnh "${this.bin}" trên máy` };
  }

  call({ system, prompt, signal, onDelta }) {
    const preset = this.preset;
    const bin = findOnPath(this.bin);
    if (!bin) return Promise.reject(new AdapterError('unavailable', `Không tìm thấy lệnh "${this.bin}"`));
    const fullPrompt = preset.systemInArgs ? prompt : `${system}\n\n---\n\n${prompt}`;
    let args = preset.args(this.cfg, system, prompt);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-chat-'));

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(IS_WIN ? quoteWin(bin) : bin, IS_WIN ? args.map(quoteWin) : args, {
          cwd, env: safeEnv(this.cfg.env), shell: IS_WIN, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        return reject(new AdapterError('unavailable', e.message));
      }
      const st = { text: '', usage: null, error: null, delta: (d) => onDelta && onDelta(d) };
      let buf = '';
      let stderr = '';
      let done = false;

      const finish = (err, val) => {
        if (done) return;
        done = true;
        signal && signal.removeEventListener('abort', onAbort);
        fs.rm(cwd, { recursive: true, force: true }, () => {});
        err ? reject(err) : resolve(val);
      };
      const onAbort = () => {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref();
        finish(new AdapterError('cancelled', 'Đã hủy'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
      }

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (preset.raw) { st.text += chunk; st.delta(chunk); return; }
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const ev = line && parseJsonLine(line);
          if (ev) preset.onEvent(ev, st);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { if (stderr.length < 8000) stderr += c; });
      child.on('error', (e) => finish(new AdapterError('unavailable', e.message)));
      child.on('close', (code) => {
        if (buf.trim() && !preset.raw) { const ev = parseJsonLine(buf.trim()); if (ev) preset.onEvent(ev, st); }
        if (st.error || (code !== 0 && !st.text)) {
          const msg = String(st.error || stderr.trim().split('\n').slice(-3).join(' ') || `Thoát với mã ${code}`).slice(0, 500);
          return finish(new AdapterError(classifyError(msg), msg));
        }
        if (!st.text.trim()) return finish(new AdapterError('error', 'Không nhận được nội dung trả lời'));
        finish(null, { text: st.text, usage: st.usage });
      });

      if (preset.promptVia === 'stdin') child.stdin.end(fullPrompt);
      else child.stdin.end();
    });
  }
}

module.exports = { CliAdapter, PRESETS, findOnPath };
