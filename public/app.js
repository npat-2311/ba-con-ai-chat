'use strict';
// Giao diện phòng chat. JavaScript thuần, không framework.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const S = {
    projects: [], conversations: [], agents: [],
    currentId: null, conv: null, messages: [], session: null,
    showArchived: false, es: null,
  };

  const STATUS_LABEL = {
    waiting: 'Đang chờ', streaming: 'Đang trả lời', done: 'Hoàn tất', error: 'Lỗi',
    cancelled: 'Đã hủy', skipped: 'Bỏ lượt',
  };
  const AGENT_STATUS = {
    connected: 'Đã kết nối', unverified: 'Chưa xác minh', not_connected: 'Chưa kết nối', error: 'Lỗi kết nối',
  };
  const SESSION_STATUS = {
    running: 'Đang thảo luận', stopping: 'Đang dừng…', synthesizing: 'Đang chốt ý…',
    done: 'Đã kết thúc', stopped: 'Đã dừng', error: 'Kết thúc do lỗi',
  };
  const ACTIVE = ['running', 'stopping', 'synthesizing'];

  // ---------- Gọi API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-phong-chat': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `Lỗi ${res.status}`);
    return data;
  }

  function showError(msg) {
    $('error').textContent = msg || '';
  }

  async function guard(fn) {
    try { showError(''); return await fn(); } catch (e) { showError(e.message); return null; }
  }

  // ---------- Hộp thoại ----------
  // fields: [{name, label, value, type:'text'|'textarea'|'select', options:[{value,label}]}]
  function dialog({ title, text, fields = [], buttons }) {
    const d = $('dialog');
    $('dialogTitle').textContent = title;
    const body = $('dialogBody');
    body.replaceChildren();
    if (text) body.append(el('p', 'dialog-text', text));
    const inputs = {};
    for (const f of fields) {
      const label = el('label', 'field');
      label.append(el('span', null, f.label));
      let input;
      if (f.type === 'textarea') { input = el('textarea'); input.rows = 3; }
      else if (f.type === 'select') {
        input = el('select');
        for (const o of f.options) { const op = el('option', null, o.label); op.value = o.value; input.append(op); }
      } else { input = el('input'); input.type = 'text'; }
      input.value = f.value ?? '';
      inputs[f.name] = input;
      label.append(input);
      body.append(label);
    }
    const actions = $('dialogActions');
    actions.replaceChildren();
    return new Promise((resolve) => {
      for (const b of buttons) {
        const btn = el('button', b.cls || '', b.label);
        btn.value = b.value;
        btn.type = 'submit';
        actions.append(btn);
      }
      d.onclose = () => {
        const v = d.returnValue;
        const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
        resolve(v && v !== 'cancel' ? { action: v, values } : null);
      };
      d.returnValue = '';
      d.showModal();
      const first = Object.values(inputs)[0];
      if (first) first.focus();
    });
  }

  // ---------- Thanh bên ----------
  function menuButton(onClick) {
    const b = el('button', 'icon more', '⋯');
    b.setAttribute('aria-label', 'Tùy chọn');
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function convItem(c) {
    const row = el('div', `item conv${c.id === S.currentId ? ' active' : ''}${c.archived ? ' archived' : ''}`);
    const name = el('button', 'name', `${c.pinned ? '📌 ' : ''}${c.title}`);
    name.addEventListener('click', () => { openConversation(c.id); closeSidebar(); });
    row.append(name, menuButton(() => convMenu(c)));
    return row;
  }

  function renderTree() {
    const tree = $('tree');
    tree.replaceChildren();
    const visible = (x) => S.showArchived || !x.archived;
    const convs = S.conversations.filter(visible).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const pinned = convs.filter((c) => c.pinned);
    if (pinned.length) {
      tree.append(el('div', 'group-title', 'Đã ghim'));
      pinned.forEach((c) => tree.append(convItem(c)));
    }

    const projects = S.projects.filter(visible).sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name));
    if (projects.length) tree.append(el('div', 'group-title', 'Dự án'));
    for (const p of projects) {
      const box = el('div', `project${p.archived ? ' archived' : ''}`);
      const head = el('div', 'item project-head');
      const name = el('button', 'name', `${p.pinned ? '📌 ' : '📁 '}${p.name}`);
      name.addEventListener('click', () => newConversation(p.id));
      name.title = 'Tạo cuộc trò chuyện mới trong dự án';
      head.append(name, menuButton(() => projectMenu(p)));
      box.append(head);
      convs.filter((c) => c.projectId === p.id).forEach((c) => box.append(convItem(c)));
      tree.append(box);
    }

    const loose = convs.filter((c) => !c.projectId || !S.projects.some((p) => p.id === c.projectId && visible(p)));
    tree.append(el('div', 'group-title', 'Chưa thuộc dự án'));
    if (!loose.length) tree.append(el('div', 'empty', 'Trống'));
    loose.forEach((c) => tree.append(convItem(c)));
  }

  async function convMenu(c) {
    const r = await dialog({
      title: 'Cuộc trò chuyện',
      fields: [
        { name: 'title', label: 'Tên', value: c.title },
        { name: 'projectId', label: 'Thuộc dự án', type: 'select', value: c.projectId || '',
          options: [{ value: '', label: '— Chưa thuộc dự án —' }, ...S.projects.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name }))] },
      ],
      buttons: [
        { label: 'Lưu', value: 'save', cls: 'primary' },
        { label: c.pinned ? 'Bỏ ghim' : 'Ghim', value: 'pin' },
        { label: c.archived ? 'Bỏ lưu trữ' : 'Lưu trữ', value: 'archive' },
        { label: 'Xóa', value: 'delete', cls: 'danger' },
        { label: 'Hủy', value: 'cancel' },
      ],
    });
    if (!r) return;
    if (r.action === 'save') await guard(() => api('PATCH', `/api/conversations/${c.id}`, { title: r.values.title, projectId: r.values.projectId || null }));
    if (r.action === 'pin') await guard(() => api('PATCH', `/api/conversations/${c.id}`, { pinned: !c.pinned }));
    if (r.action === 'archive') await guard(() => api('PATCH', `/api/conversations/${c.id}`, { archived: !c.archived }));
    if (r.action === 'delete') {
      const ok = await dialog({
        title: 'Xóa cuộc trò chuyện?',
        text: `"${c.title}" cùng toàn bộ tin nhắn, tin ghim và tóm tắt của nó sẽ bị xóa vĩnh viễn.`,
        buttons: [{ label: 'Xóa vĩnh viễn', value: 'yes', cls: 'danger' }, { label: 'Hủy', value: 'cancel' }],
      });
      if (!ok) return;
      await guard(() => api('DELETE', `/api/conversations/${c.id}`));
      if (S.currentId === c.id) { S.currentId = null; S.conv = null; S.messages = []; S.session = null; }
    }
    await loadState();
  }

  async function projectMenu(p) {
    const r = await dialog({
      title: 'Dự án',
      fields: [
        { name: 'name', label: 'Tên', value: p.name },
        { name: 'description', label: 'Mô tả (tùy chọn)', value: p.description, type: 'textarea' },
        { name: 'goal', label: 'Mục tiêu', value: p.goal, type: 'textarea' },
        { name: 'instructions', label: 'Hướng dẫn chung cho các AI', value: p.instructions, type: 'textarea' },
      ],
      buttons: [
        { label: 'Lưu', value: 'save', cls: 'primary' },
        { label: 'Trò chuyện mới', value: 'new' },
        { label: p.pinned ? 'Bỏ ghim' : 'Ghim', value: 'pin' },
        { label: p.archived ? 'Bỏ lưu trữ' : 'Lưu trữ', value: 'archive' },
        { label: 'Xóa', value: 'delete', cls: 'danger' },
        { label: 'Hủy', value: 'cancel' },
      ],
    });
    if (!r) return;
    if (r.action === 'save') await guard(() => api('PATCH', `/api/projects/${p.id}`, r.values));
    if (r.action === 'new') return newConversation(p.id);
    if (r.action === 'pin') await guard(() => api('PATCH', `/api/projects/${p.id}`, { pinned: !p.pinned }));
    if (r.action === 'archive') await guard(() => api('PATCH', `/api/projects/${p.id}`, { archived: !p.archived }));
    if (r.action === 'delete') {
      const n = S.conversations.filter((c) => c.projectId === p.id).length;
      const ok = await dialog({
        title: `Xóa dự án "${p.name}"?`,
        text: `Dự án có ${n} cuộc trò chuyện. Mục tiêu, hướng dẫn chung của dự án sẽ bị xóa. Chọn cách xử lý các cuộc trò chuyện:\n• Giữ lại: chuyển ${n} cuộc trò chuyện sang "Chưa thuộc dự án" (tin ghim vẫn còn nhưng chỉ dùng trong từng cuộc).\n• Xóa hết: xóa vĩnh viễn ${n} cuộc trò chuyện cùng tin nhắn.`,
        buttons: [
          { label: `Xóa dự án, giữ ${n} cuộc trò chuyện`, value: 'detach', cls: 'danger' },
          { label: `Xóa dự án và ${n} cuộc trò chuyện`, value: 'delete', cls: 'danger' },
          { label: 'Hủy', value: 'cancel' },
        ],
      });
      if (!ok) return;
      await guard(() => api('DELETE', `/api/projects/${p.id}?mode=${ok.action}`));
      if (ok.action === 'delete' && S.conv && S.conv.projectId === p.id) { S.currentId = null; S.conv = null; S.messages = []; S.session = null; }
    }
    await loadState();
  }

  async function newConversation(projectId) {
    const c = await guard(() => api('POST', '/api/conversations', { projectId: projectId || null }));
    if (!c) return;
    await loadState();
    await openConversation(c.id);
    closeSidebar();
    $('input').focus();
  }

  async function newProject() {
    const r = await dialog({
      title: 'Dự án mới',
      fields: [
        { name: 'name', label: 'Tên', value: '' },
        { name: 'description', label: 'Mô tả (tùy chọn)', type: 'textarea' },
        { name: 'goal', label: 'Mục tiêu', type: 'textarea' },
        { name: 'instructions', label: 'Hướng dẫn chung cho các AI', type: 'textarea' },
      ],
      buttons: [{ label: 'Tạo', value: 'ok', cls: 'primary' }, { label: 'Hủy', value: 'cancel' }],
    });
    if (!r) return;
    await guard(() => api('POST', '/api/projects', r.values));
    await loadState();
  }

  // ---------- AI tham gia ----------
  function selectedParticipants() {
    const sel = S.conv && S.conv.settings.participants;
    return S.agents.filter((a) => (sel ? sel.includes(a.id) : true)).map((a) => a.id);
  }

  function renderAgents() {
    const box = $('agents');
    box.replaceChildren();
    const sel = new Set(selectedParticipants());
    for (const a of S.agents) {
      const usable = a.status === 'connected' || a.status === 'unverified';
      const chip = el('label', `chip status-${a.status}`);
      chip.title = `${AGENT_STATUS[a.status]} — ${a.detail || ''}\nNguồn hạn mức: ${a.costSource || 'không rõ'}\nStreaming: ${a.capabilities.streaming ? 'có' : 'không'} · Hủy yêu cầu: ${a.capabilities.cancel ? 'có' : 'không'}`;
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(a.id) && usable;
      cb.disabled = !usable || !S.conv;
      cb.addEventListener('change', () => toggleParticipant(a.id, cb.checked));
      chip.append(cb, el('span', 'dot'), el('span', 'agent-name', a.name), el('span', 'agent-status', a.simulated ? 'Giả lập' : AGENT_STATUS[a.status]));
      if (a.status !== 'not_connected') {
        const t = el('button', 'icon test', '⟳');
        t.title = 'Kiểm tra kết nối (tốn 1 lượt gọi ngắn)';
        t.setAttribute('aria-label', `Kiểm tra kết nối ${a.name}`);
        t.addEventListener('click', async (e) => {
          e.preventDefault();
          t.disabled = true;
          t.textContent = '…';
          await guard(() => api('POST', `/api/agents/${a.id}/test`));
          await loadState();
        });
        chip.append(t);
      }
      box.append(chip);
    }
  }

  async function toggleParticipant(id, on) {
    const cur = new Set(selectedParticipants());
    if (on) cur.add(id); else cur.delete(id);
    const c = await guard(() => api('PATCH', `/api/conversations/${S.currentId}`, { settings: { participants: [...cur] } }));
    if (c) { S.conv.settings = c.settings; render(); }
  }

  // ---------- Tin nhắn ----------
  function msgNode(m) {
    if (m.status === 'skipped') {
      return el('div', 'msg skipped', `${m.agentName} bỏ lượt ở vòng ${m.round} (không có ý mới).`);
    }
    const kind = m.kind === 'synthesis' ? ' synthesis' : m.kind === 'summary' ? ' summary' : '';
    const node = el('article', `msg ${m.role}${kind} st-${m.status}`);
    node.id = `m-${m.id}`;
    const head = el('div', 'msg-head');
    head.append(el('span', 'who', m.role === 'user' ? 'Bạn' : m.agentName));
    if (m.role === 'agent') {
      const tag = m.kind === 'synthesis' ? 'Chốt ý' : m.kind === 'summary' ? 'Cập nhật tóm tắt' : `Vòng ${m.round}`;
      head.append(el('span', 'tag', tag));
      head.append(el('span', `badge b-${m.status}`, STATUS_LABEL[m.status] || m.status));
      if (m.meta && m.meta.state === 'CAN_QUYET_DINH') head.append(el('span', 'tag warn', 'Cần bạn quyết định'));
    }
    if (m.pinned) head.append(el('span', 'tag pin', '📌 Ghim ngữ cảnh'));
    node.append(head);

    const body = el('div', 'md');
    if (m.content) body.innerHTML = window.renderMarkdown(m.content);
    else if (m.status === 'waiting') body.append(el('span', 'muted', '…'));
    node.append(body);
    if (m.error) node.append(el('div', 'msg-error', m.error));
    if (m.status === 'cancelled') node.append(el('div', 'muted small', 'Đã dừng. Nội dung có thể chưa đầy đủ; lượt gọi đã bắt đầu vẫn có thể được tính vào hạn mức.'));

    if (m.content && ['done', 'cancelled'].includes(m.status) || m.role === 'user') {
      const actions = el('div', 'msg-actions');
      const copy = el('button', 'link', 'Sao chép');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(m.content); copy.textContent = 'Đã chép'; }
        catch { copy.textContent = 'Không chép được'; }
        setTimeout(() => { copy.textContent = 'Sao chép'; }, 1500);
      });
      const pin = el('button', 'link', m.pinned ? 'Bỏ ghim ngữ cảnh' : 'Ghim làm ngữ cảnh');
      pin.title = 'Tin được ghim sẽ được đưa vào các lượt thảo luận tiếp theo của cuộc trò chuyện/dự án';
      pin.addEventListener('click', async () => {
        const r = await guard(() => api('PATCH', `/api/messages/${m.id}`, { pinned: !m.pinned }));
        if (r) upsertMessage(r);
      });
      actions.append(copy, pin);
      if (m.usage && (m.usage.inputTokens || m.usage.outputTokens)) {
        actions.append(el('span', 'muted small', `Token (nhà cung cấp báo): vào ${m.usage.inputTokens ?? '?'} · ra ${m.usage.outputTokens ?? '?'}`));
      }
      node.append(actions);
    }
    if (m.kind === 'summary') {
      const d = el('details', 'msg summary');
      d.append(el('summary', null, `${m.agentName}: cập nhật tóm tắt ngữ cảnh (1 lượt gọi)`), node);
      return d;
    }
    return node;
  }

  function renderMessages() {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.replaceChildren();
    if (!S.conv) {
      box.append(el('div', 'empty big', 'Chọn hoặc tạo một cuộc trò chuyện ở thanh bên.'));
      return;
    }
    if (!S.messages.length) box.append(el('div', 'empty big', 'Gửi một tin nhắn: tất cả AI đang bật và đã kết nối sẽ cùng thảo luận.'));
    let lastSession = null;
    for (const m of S.messages) {
      if (m.sessionId && m.sessionId !== lastSession && m.role === 'user' && lastSession) box.append(el('hr', 'session-sep'));
      lastSession = m.sessionId || lastSession;
      box.append(msgNode(m));
    }
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function upsertMessage(m) {
    if (!S.conv || m.conversationId !== S.currentId) return;
    const i = S.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) S.messages[i] = m; else S.messages.push(m);
    const old = document.getElementById(`m-${m.id}`);
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (old && m.kind !== 'summary' && m.status !== 'skipped') old.replaceWith(msgNode(m));
    else renderMessages();
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- Thanh trạng thái ----------
  function renderStats() {
    const s = S.session;
    const st = $('stats');
    st.replaceChildren();
    const n = selectedParticipants().filter((id) => S.agents.find((a) => a.id === id && (a.status === 'connected' || a.status === 'unverified'))).length;
    const max = Number($('roundsInput').value) || 3;
    $('roundsHint').textContent = `Với ${n} AI, ${max} vòng có thể tạo tới ${n * max} phản hồi thảo luận.`;
    if (!s) return;
    const names = Object.fromEntries(S.agents.map((a) => [a.id, a.name]));
    st.append(el('span', `pill s-${s.status}`, SESSION_STATUS[s.status] || s.status));
    st.append(el('strong', null, `Vòng ${s.round}/${s.maxRounds}`));
    const per = Object.entries(s.calls.byAgent).map(([id, c]) => `${names[id] || id} ${c}`).join(' · ');
    st.append(el('span', null, `Lượt gọi thực tế: ${s.calls.total}${per ? ` (${per})` : ''}`));
    if (s.stopReason && !ACTIVE.includes(s.status)) st.append(el('span', 'muted', s.stopReason));
  }

  function renderControls() {
    const s = S.session;
    const running = !!(s && ACTIVE.includes(s.status));
    $('stopBtn').hidden = !running;
    $('sendBtn').disabled = !S.conv;
    $('input').disabled = !S.conv;
    $('continueBtn').disabled = !s || running || s.round >= 100;
    $('continueBtn').title = s && s.round >= 100 ? 'Phiên đã đạt 100 vòng. Gửi tin mới để bắt đầu phiên mới (tóm tắt được giữ lại).' : 'Chạy thêm đúng một vòng';
    $('synthBtn').disabled = !s || (s.status === 'synthesizing') || (s.status === 'stopping');
    $('sendBtn').textContent = running ? 'Gửi (dừng phiên cũ)' : 'Gửi';
  }

  function renderHeader() {
    $('convTitle').textContent = S.conv ? S.conv.title : 'Chưa chọn cuộc trò chuyện';
    const p = S.conv && S.conv.projectId && S.projects.find((x) => x.id === S.conv.projectId);
    $('convSub').textContent = S.conv ? (p ? `Dự án: ${p.name}` : 'Chưa thuộc dự án') : '';
    const sum = S.conv && S.conv.summary && S.conv.summary.text;
    $('summaryBox').hidden = !sum;
    if (sum) $('summaryText').innerHTML = window.renderMarkdown(sum);
  }

  function render() {
    renderTree();
    renderHeader();
    renderAgents();
    renderMessages();
    renderStats();
    renderControls();
  }

  // ---------- Dữ liệu ----------
  async function loadState() {
    const st = await guard(() => api('GET', '/api/state'));
    if (!st) return;
    Object.assign(S, { projects: st.projects, conversations: st.conversations, agents: st.agents });
    if (S.currentId && !S.conversations.some((c) => c.id === S.currentId)) S.currentId = null;
    if (S.currentId) {
      const c = S.conversations.find((x) => x.id === S.currentId);
      if (S.conv) Object.assign(S.conv, c);
    }
    render();
  }

  function setRounds(n) {
    $('roundsInput').value = n;
    const quick = [...$('roundsQuick').options].map((o) => Number(o.value));
    $('roundsQuick').value = quick.includes(n) ? String(n) : '';
  }

  async function openConversation(id) {
    const data = await guard(() => api('GET', `/api/conversations/${id}`));
    if (!data) return;
    S.currentId = id;
    S.conv = data.conversation;
    S.messages = data.messages;
    S.session = data.session;
    try { localStorage.setItem('phongchat.current', id); } catch {}
    setRounds(S.conv.settings.maxRounds || 3);
    connectEvents();
    render();
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  function connectEvents() {
    if (S.es) S.es.close();
    if (!S.currentId) return;
    const es = new EventSource(`/api/events?conversationId=${encodeURIComponent(S.currentId)}`);
    es.addEventListener('message', (e) => upsertMessage(JSON.parse(e.data)));
    es.addEventListener('session', (e) => {
      const s = JSON.parse(e.data);
      if (s.conversationId !== S.currentId) return;
      applySession(s);
    });
    es.addEventListener('conversation', (e) => {
      const c = JSON.parse(e.data);
      if (c.id === S.currentId) { S.conv = c; renderHeader(); }
    });
    // Mỗi lần (tái) kết nối: đồng bộ lại dữ liệu đã lưu. Chỉ đọc, không gọi AI.
    es.addEventListener('open', async () => {
      const data = await api('GET', `/api/conversations/${S.currentId}`).catch(() => null);
      if (!data || data.conversation.id !== S.currentId) return;
      S.messages = data.messages;
      S.conv = data.conversation;
      if (data.session) applySession(data.session);
      renderMessages(); renderHeader();
    });
    es.addEventListener('agents', (e) => { S.agents = JSON.parse(e.data); renderAgents(); renderStats(); });
    S.es = es;
  }

  // Phản hồi HTTP và sự kiện SSE có thể đến lệch thứ tự: chỉ nhận trạng thái mới hơn.
  function applySession(s) {
    if (!s || s.conversationId !== S.currentId) return;
    const cur = S.session;
    if (cur && cur.id === s.id && (s.version || 0) < (cur.version || 0)) return;
    if (cur && cur.id !== s.id && s.createdAt < cur.createdAt) return;
    S.session = s;
    renderStats(); renderControls();
  }

  // ---------- Hành động ----------
  function readRounds() {
    const v = $('roundsInput').value.trim();
    const n = Number(v);
    if (!/^\d+$/.test(v) || n < 1 || n > 100) throw new Error('Số vòng tối đa phải là số nguyên từ 1 đến 100');
    return n;
  }

  async function send() {
    const text = $('input').value.trim();
    if (!text || !S.conv) return;
    await guard(async () => {
      const maxRounds = readRounds();
      const s = await api('POST', `/api/conversations/${S.currentId}/send`, { text, maxRounds, participants: selectedParticipants() });
      $('input').value = '';
      applySession(s);
    });
  }

  async function roundsChanged(n) {
    await guard(async () => {
      if (!/^\d+$/.test(String(n)) || n < 1 || n > 100) { setRounds(S.conv ? S.conv.settings.maxRounds : 3); throw new Error('Số vòng tối đa phải là số nguyên từ 1 đến 100'); }
      setRounds(n);
      if (!S.conv) return;
      if (S.session && ACTIVE.includes(S.session.status)) {
        applySession(await api('PATCH', `/api/sessions/${S.session.id}`, { maxRounds: n }));
      } else {
        const c = await api('PATCH', `/api/conversations/${S.currentId}`, { settings: { maxRounds: n } });
        S.conv.settings = c.settings;
      }
      renderStats(); renderControls();
    });
  }

  function closeSidebar() { document.body.classList.remove('sidebar-open'); }

  function bind() {
    $('sendBtn').addEventListener('click', send);
    $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    $('stopBtn').addEventListener('click', () => guard(async () => applySession(await api('POST', `/api/sessions/${S.session.id}/stop`))));
    $('continueBtn').addEventListener('click', () => guard(async () => applySession(await api('POST', `/api/sessions/${S.session.id}/continue`))));
    $('synthBtn').addEventListener('click', () => guard(async () => applySession(await api('POST', `/api/sessions/${S.session.id}/synthesize`))));
    $('roundsQuick').addEventListener('change', (e) => { if (e.target.value) roundsChanged(Number(e.target.value)); });
    $('roundsInput').addEventListener('change', (e) => roundsChanged(e.target.value.trim() === '' ? NaN : Number(e.target.value)));
    $('newConv').addEventListener('click', () => newConversation(null));
    $('newProject').addEventListener('click', newProject);
    $('showArchived').addEventListener('change', (e) => { S.showArchived = e.target.checked; renderTree(); });
    $('openSidebar').addEventListener('click', () => document.body.classList.add('sidebar-open'));
    $('closeSidebar').addEventListener('click', closeSidebar);
    $('backdrop').addEventListener('click', closeSidebar);
  }

  // Mở trang: chỉ tải dữ liệu, không gọi AI.
  async function init() {
    bind();
    await loadState();
    let last = null;
    try { last = localStorage.getItem('phongchat.current'); } catch {}
    if (last && S.conversations.some((c) => c.id === last)) await openConversation(last);
  }
  init();
})();
