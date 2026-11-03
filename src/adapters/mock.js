'use strict';
// Adapter GIẢ LẬP — chỉ dùng để kiểm tra bộ điều phối mà không tốn hạn mức.
// Tên luôn có hậu tố "(giả lập)" để không bị nhầm với AI thật.
const { AdapterError } = require('./base');

class MockAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = `${cfg.name || cfg.id} (giả lập)`;
    this.type = 'mock';
    this.capabilities = { streaming: true, cancel: !cfg.ignoreAbort };
    this.costSource = 'Giả lập, không tốn hạn mức';
    this.calls = [];
  }

  isConfigured() { return { ok: true, detail: 'Kết nối giả lập' }; }

  call({ system, prompt, signal, onDelta }) {
    this.calls.push({ system, prompt });
    const cfg = this.cfg;
    const round = Number((system.match(/vòng (\d+)\/(\d+)/) || [])[1] || 1);
    const prevRound = prompt.match(/\[PHẢN HỒI VÒNG (\d+)\]/);
    const heard = [...prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]).filter((n) => n !== this.name);
    let text;
    if (/chốt ý cuộc thảo luận/.test(system)) {
      text = '## Kết luận\nÝ giả lập.\n## Điểm còn bất đồng\nKhông.\n## Thông tin cần bổ sung\nKhông.\n## Bước tiếp theo\nThử với AI thật.';
    } else if (/Cập nhật bản tóm tắt/.test(system)) {
      text = '- Tóm tắt giả lập.';
    } else if (cfg.skipFromRound && round >= cfg.skipFromRound) {
      text = '<<<BO_LUOT>>>';
    } else {
      const state = cfg.agreeFromRound && round >= cfg.agreeFromRound ? 'THONG_NHAT' : 'MOI';
      const ref = prevRound ? `Đã đọc vòng ${prevRound[1]} của: ${heard.join(', ') || 'không ai'}.` : 'Ý kiến đầu tiên.';
      text = `[${this.name}] vòng ${round}. ${ref}\n<<<TRANG_THAI: ${state}>>>`;
    }
    const delay = cfg.delayMs ?? 30;
    return new Promise((resolve, reject) => {
      let finished = false;
      const t = setTimeout(() => {
        finished = true;
        if (cfg.fail) return reject(new AdapterError(cfg.fail, `Lỗi giả lập (${cfg.fail})`));
        const half = Math.floor(text.length / 2);
        onDelta && onDelta(text.slice(0, half));
        onDelta && onDelta(text.slice(half));
        resolve({ text, usage: null });
      }, delay);
      if (signal && !cfg.ignoreAbort) {
        signal.addEventListener('abort', () => {
          if (finished) return;
          clearTimeout(t);
          reject(new AdapterError('cancelled', 'Đã hủy'));
        });
      }
    });
  }
}

module.exports = { MockAdapter };
