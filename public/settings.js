'use strict';
// Trang "Kết nối AI": bật/tắt, đăng nhập CLI, nhập API key, thêm agent ngoài, tạo khóa API — không cần sửa file.
(function () {
  const { api, el, guard, loadState, closeSidebar, $ } = window.PC;
  const view = $('settingsView');
  const chatParts = ['agents', 'stats', 'summaryBox', 'messages', 'composer'];
  let data = null;
  const auth = {}; // agentId -> kết quả kiểm tra đăng nhập
  const jobs = {}; // agentId -> job
  let newKey = null;

  const STATUS = {
    connected: 'Đã kết nối', unverified: 'Chưa xác minh', not_connected: 'Chưa kết nối',
    error: 'Lỗi kết nối', disabled: 'Đang tắt',
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linkify = (s) => esc(s).replace(/https?:\/\/[^\s"'<>]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

  function button(label, onClick, cls = '') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await onClick(); } finally { b.disabled = false; }
    });
    return b;
  }

  function input(value, { type = 'text', placeholder = '' } = {}) {
    const i = el('input');
    i.type = type;
    i.value = value || '';
    i.placeholder = placeholder;
    return i;
  }

  function field(label, control, note) {
    const f = el('label', 'field');
    f.append(el('span', null, label), control);
    if (note) f.append(el('span', 'muted small', note));
    return f;
  }

  function msg(text, cls = '') {
    const p = el('p', `small ${cls}`);
    p.textContent = text;
    return p;
  }

  async function refresh() {
    data = await guard(() => api('GET', '/api/settings'));
    if (!data) return;
    render();
  }

  async function checkAuth(a) {
    auth[a.id] = { loading: true };
    render();
    auth[a.id] = await api('GET', `/api/settings/agents/${a.id}/auth-status`).catch((e) => ({ message: e.message }));
    render();
  }

  async function patch(a, body) {
    const r = await guard(() => api('PATCH', `/api/settings/agents/${a.id}`, body));
    if (r) { data = r; render(); loadState(); }
    return r;
  }

  async function startJob(a, kind) {
    const j = await guard(() => api('POST', `/api/settings/agents/${a.id}/jobs`, { kind }));
    if (!j) return;
    jobs[a.id] = j;
    render();
    const poll = async () => {
      const cur = await api('GET', `/api/jobs/${j.id}`).catch(() => null);
      if (!cur) return;
      jobs[a.id] = cur;
      renderJob(a.id);
      if (!cur.done) return setTimeout(poll, 1000);
      await patch(a, {}); // xóa trạng thái lỗi cũ, nạp lại kết nối
      checkAuth(a);
    };
    setTimeout(poll, 800);
  }

  function renderJob(agentId) {
    const box = document.getElementById(`job-${agentId}`);
    const j = jobs[agentId];
    if (!box || !j) return;
    box.replaceChildren();
    box.append(msg(j.hint));
    const pre = el('pre', 'job-out');
    pre.innerHTML = j.lines.length ? j.lines.map(linkify).join('\n') : '…';
    box.append(pre);
    if (!j.done) {
      const row = el('div', 'row');
      const inp = input('', { placeholder: 'Dán mã đăng nhập (nếu được yêu cầu)' });
      row.append(inp, button('Gửi', async () => {
        if (!inp.value.trim()) return;
        await guard(() => api('POST', `/api/jobs/${j.id}/input`, { text: inp.value }));
        inp.value = '';
      }), button('Hủy', () => guard(() => api('POST', `/api/jobs/${j.id}/cancel`)), 'danger'));
      box.append(row);
    } else {
      box.append(msg(j.exitCode === 0 ? 'Đã xong.' : `Kết thúc với mã ${j.exitCode}. Nếu chưa được, xem nội dung phía trên.`, j.exitCode === 0 ? 'ok' : 'warn'));
    }
  }

  function cliSection(a, card) {
    const st = auth[a.id];
    if (!st) checkAuth(a);
    if (st && !st.loading) {
      card.append(msg(st.message || '', st.paid ? 'warn' : st.loggedIn ? 'ok' : ''));
      if (st.paid) card.append(msg('Ứng dụng không tự dùng API trả phí. Hãy đăng nhập lại bằng tài khoản thuê bao.', 'warn'));
    } else card.append(msg('Đang kiểm tra đăng nhập…', 'muted'));

    const row = el('div', 'row');
    if (st && st.installed === false) {
      row.append(button(`Cài đặt ${a.preset === 'codex' ? 'Codex CLI' : 'Claude Code'}`, () => startJob(a, 'install'), 'primary'));
    } else if (a.canLogin) {
      row.append(button(st && st.loggedIn ? 'Đăng nhập lại' : 'Đăng nhập', () => startJob(a, 'login'), st && st.loggedIn ? '' : 'primary'));
      if (a.preset === 'codex') row.append(button('Đăng nhập bằng mã thiết bị', () => startJob(a, 'loginDevice')));
    }
    row.append(button('Kiểm tra lại', () => checkAuth(a)));
    card.append(row);
    if (a.preset === 'claude') card.append(msg('Nếu không hiện liên kết đăng nhập: mở Terminal, chạy "claude", gõ /login, rồi bấm Kiểm tra lại.', 'muted'));
    if (a.preset === 'codex') card.append(msg('Nếu nút Đăng nhập không hiện liên kết: mở Terminal, chạy "codex login", rồi bấm Kiểm tra lại.', 'muted'));
    const jobBox = el('div', 'job');
    jobBox.id = `job-${a.id}`;
    card.append(jobBox);
  }

  function keySection(a, card) {
    if (a.type === 'gemini-api') {
      const p = el('p', 'small');
      p.innerHTML = 'Lấy API key miễn phí tại <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>. Bậc miễn phí: Google được dùng nội dung để cải thiện sản phẩm, đừng gửi thông tin nhạy cảm. Nếu project của key đã bật thanh toán thì có thể bị tính phí.';
      card.append(p);
    }
    const key = input('', { type: 'password', placeholder: a.hasKey ? `Đã lưu ${a.keyHint} (từ ${a.keySource})` : 'Dán API key' });
    key.autocomplete = 'off';
    card.append(field('API key', key, 'Key chỉ lưu trên máy chạy ứng dụng (data/settings.json), không hiện lại trên trình duyệt.'));
    const row = el('div', 'row');
    row.append(button('Lưu key', async () => {
      if (!key.value.trim()) return;
      if (await patch(a, { apiKey: key.value })) key.value = '';
    }, 'primary'));
    if (a.hasKey && a.keySource === 'giao diện') row.append(button('Xóa key', () => patch(a, { clearKey: true }), 'danger'));
    card.append(row);
  }

  function agentCard(a) {
    const card = el('div', `card status-${a.status}`);
    const head = el('div', 'card-head');
    const title = el('strong', null, a.name);
    const badge = el('span', 'badge', a.simulated ? 'Giả lập' : STATUS[a.status] || a.status);
    const toggle = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !a.disabled;
    cb.addEventListener('change', () => patch(a, { disabled: !cb.checked }));
    toggle.append(cb, document.createTextNode(' Bật'));
    head.append(title, badge, el('span', 'spacer'), toggle);
    card.append(head);
    if (a.costSource) card.append(msg(`Nguồn hạn mức: ${a.costSource}`, 'muted'));
    if (a.status === 'error' && a.detail) card.append(msg(a.detail, 'warn'));
    if (a.disabled) return card;

    if (a.type === 'cli' && a.canLogin) cliSection(a, card);
    if (a.type === 'cli' && a.preset === 'agy') {
      card.append(msg('Antigravity CLI: điều khoản của Google có thể coi việc dùng từ ứng dụng khác là vi phạm, có rủi ro khóa tài khoản. Định dạng đầu ra chưa được xác minh. Đăng nhập bằng cách chạy "agy" trong Terminal.', 'warn'));
    }
    if (a.needsKey) keySection(a, card);
    if (a.type === 'openai-compat') {
      const base = input(a.baseUrl, { placeholder: 'http://127.0.0.1:11434/v1' });
      card.append(field('Địa chỉ endpoint (tương thích OpenAI)', base));
      card._base = base;
    }

    if (a.type !== 'mock') {
      const model = input(a.model, { placeholder: a.preset === 'codex' ? 'Để trống = mặc định của gói' : '' });
      card.append(field('Model', model, a.preset === 'claude' ? 'Ví dụ: sonnet, haiku, opus. Model lớn tốn hạn mức nhanh hơn.' : ''));
      const row = el('div', 'row');
      row.append(button('Lưu', () => patch(a, Object.assign({ model: model.value }, card._base ? { baseUrl: card._base.value } : {}))));
      if (a.status !== 'not_connected') {
        row.append(button('Kiểm tra kết nối (1 lượt gọi)', async () => {
          await guard(() => api('POST', `/api/agents/${a.id}/test`));
          await refresh();
          loadState();
        }));
      }
      if (a.custom) row.append(button('Xóa agent', async () => {
        const r = await guard(() => api('DELETE', `/api/settings/agents/${a.id}`));
        if (r) { data = r; render(); loadState(); }
      }, 'danger'));
      card.append(row);
    }
    return card;
  }

  function addAgentCard() {
    const card = el('div', 'card');
    card.append(el('strong', null, 'Thêm agent ngoài'));
    card.append(msg('Dành cho endpoint tương thích OpenAI Chat Completions (Ollama, LM Studio, agent tự viết). Chỉ thêm khi bạn đã biết endpoint đó tương thích. Địa chỉ api.openai.com (trả phí) bị chặn.', 'muted'));
    const name = input('', { placeholder: 'Ví dụ: Llama trên máy' });
    const base = input('', { placeholder: 'http://127.0.0.1:11434/v1' });
    const model = input('', { placeholder: 'llama3.2' });
    const key = input('', { type: 'password', placeholder: 'Không bắt buộc' });
    card.append(field('Tên', name), field('Địa chỉ endpoint', base), field('Model', model), field('API key', key));
    card.append(button('Thêm', async () => {
      const r = await guard(() => api('POST', '/api/settings/agents', { name: name.value, baseUrl: base.value, model: model.value, apiKey: key.value }));
      if (r) { data = r; render(); loadState(); }
    }, 'primary'));
    return card;
  }

  function apiKeysCard() {
    const card = el('div', 'card');
    card.append(el('strong', null, 'Khóa API cho agent/công cụ khác'));
    card.append(msg('Cho phép công cụ khác gọi API /v1 của ứng dụng (xem README). Khóa chỉ hiện một lần khi tạo.', 'muted'));
    if (newKey) {
      const box = el('div', 'new-key');
      box.append(msg(`Khóa "${newKey.id}" — sao chép ngay, sẽ không hiện lại:`), el('code', null, newKey.key));
      box.append(button('Sao chép', async () => { try { await navigator.clipboard.writeText(newKey.key); } catch {} }));
      card.append(box);
    }
    for (const k of data.apiKeys) {
      const row = el('div', 'row key-row');
      row.append(el('span', null, `${k.id} ${k.hint} · quyền: ${k.scopes.join(', ')} · dự án: ${k.projects.includes('*') ? 'tất cả' : k.projects.join(', ')}`));
      row.append(button('Thu hồi', async () => {
        const r = await guard(() => api('DELETE', `/api/settings/api-keys/${encodeURIComponent(k.id)}`));
        if (r) { data = r; newKey = null; render(); }
      }, 'danger'));
      card.append(row);
    }
    const name = input('', { placeholder: 'Ví dụ: agent-ghi-chu' });
    const scopes = el('div', 'row');
    const boxes = {};
    for (const [s, label] of [['read', 'Xem'], ['write', 'Tạo và gửi chủ đề'], ['control', 'Dừng, chốt ý']]) {
      const l = el('label', 'toggle');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = true;
      boxes[s] = c;
      l.append(c, document.createTextNode(` ${label}`));
      scopes.append(l);
    }
    const proj = el('select');
    for (const o of [{ id: '*', name: 'Tất cả dự án' }, ...data.projects]) {
      const op = el('option', null, o.name);
      op.value = o.id;
      proj.append(op);
    }
    card.append(field('Tên khóa', name), field('Quyền', scopes), field('Phạm vi', proj));
    card.append(button('Tạo khóa', async () => {
      const r = await guard(() => api('POST', '/api/settings/api-keys', {
        name: name.value, scopes: Object.keys(boxes).filter((s) => boxes[s].checked), projects: [proj.value],
      }));
      if (r) { newKey = r; await refresh(); }
    }, 'primary'));
    return card;
  }

  function render() {
    if (!data || view.hidden) return;
    view.replaceChildren();
    const head = el('div', 'settings-head');
    head.append(button('← Về phòng chat', close));
    const err = el('div', 'error');
    err.id = 'settingsError';
    err.setAttribute('role', 'alert');
    view.append(head, err);
    view.append(msg('Các nút trên trang này không gọi AI và không tốn hạn mức, trừ nút "Kiểm tra kết nối (1 lượt gọi)". Đăng nhập và cài đặt chỉ bấm được trên chính máy đang chạy ứng dụng.', 'muted'));
    for (const a of data.agents) view.append(agentCard(a));
    view.append(addAgentCard(), apiKeysCard());
    for (const id of Object.keys(jobs)) renderJob(id);
  }

  function open() {
    view.hidden = false;
    chatParts.forEach((id) => { $(id).classList.add('hidden-by-settings'); });
    closeSidebar();
    loadState();
    refresh();
  }

  function close() {
    view.hidden = true;
    chatParts.forEach((id) => { $(id).classList.remove('hidden-by-settings'); });
    loadState();
  }

  $('openSettings').addEventListener('click', open);
  window.PCSettings = { open, close };
})();
