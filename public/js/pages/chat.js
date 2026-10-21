import { state, api, esc, icon, page, forms, changes, onPage, avatar, emptyState, fmtTime, fmtDate, timeAgo, uploadImage, toast, hooks } from '../core.js';

function chatList(chats, activeId) {
  if (!chats.length) return `<div style="padding:12px">${emptyState('chat', 'Tiada perbualan', 'Buka mana-mana kedai dan tekan "Chat peniaga" untuk bertanya terus.')}</div>`;
  return chats.map((c) => `
    <a href="#/chat/${c.id}" class="${c.id === activeId ? 'active' : ''}" data-chat="${c.id}">
      ${avatar(c.other)}
      <div class="grow">
        <div class="between"><b class="small clamp-1">${esc(chatTitle(c))}</b><span class="xs faint nowrap">${c.last ? timeAgo(c.last.created_at) : ''}</span></div>
        <div class="between"><span class="xs muted clamp-1">${c.last ? `${c.last.sender_id === state.me.id ? 'Anda: ' : ''}${esc(c.last.body || '📷 Gambar')}` : 'Mulakan perbualan'}</span>${c.unread ? `<span class="unread-n">${c.unread}</span>` : ''}</div>
      </div>
    </a>`).join('');
}
const chatTitle = (c) => (c.kind === 'support' ? (c.other.role === 'admin' ? 'Sokongan UPSIHub' : `${c.other.name} (sokongan)`) : c.shop ? `${c.shop.name}` : c.other.name);

function bubble(m, prevDay) {
  const day = fmtDate(m.created_at);
  const sep = day !== prevDay ? `<div class="day-sep">${day}</div>` : '';
  const mine = m.sender_id === state.me.id;
  return `${sep}<div class="msg ${mine ? 'me' : ''}" data-mid="${m.id}" data-at="${m.created_at}">${m.image ? `<img src="${esc(m.image)}" alt="" data-act="zoom" data-src="${esc(m.image)}">` : ''}${m.body ? esc(m.body) : ''}<span class="meta">${fmtTime(m.created_at)}${mine ? ` <span data-read>${m.read_at ? '✓✓' : '✓'}</span>` : ''}</span></div>`;
}

async function render(id) {
  const { chats } = await api('GET', '/api/chats');
  let pane = `<div class="chat-pane" style="display:grid;place-items:center">${emptyState('chat', 'Pilih perbualan', 'Mesej dihantar & diterima secara masa nyata – tanpa aplikasi pihak ketiga.')}</div>`;
  let after = null;

  if (id) {
    const { chat, messages } = await api('GET', `/api/chats/${id}/messages`);
    let lastDay = null;
    const msgsHtml = messages.map((m) => { const h = bubble(m, lastDay); lastDay = fmtDate(m.created_at); return h; }).join('');
    pane = `
      <div class="chat-pane">
        <div class="chat-head">
          <a href="#/chat" class="btn btn-ghost btn-icon" aria-label="Kembali" style="${matchMedia('(min-width: 900px)').matches ? 'display:none' : ''}">${icon('back')}</a>
          ${avatar(chat.other)}
          <div class="grow"><div class="bold clamp-1">${esc(chatTitle(chat))}</div><div class="xs faint">${chat.other.online ? '<span style="color:var(--accent-600)">● Dalam talian</span>' : 'Luar talian – mesej akan dihantar sebagai notifikasi'}</div></div>
          ${chat.shop ? `<a class="btn btn-ghost btn-sm" href="#/shop/${chat.shop.id}">${icon('store')} Kedai</a>` : ''}
        </div>
        <div class="msgs" id="msgs">${msgsHtml || `<div class="day-sep">Mulakan perbualan dengan ${esc(chat.other.name)}</div>`}</div>
        <form class="composer" data-form="sendMsg" data-id="${chat.id}" id="composer">
          <label class="btn btn-ghost btn-icon" aria-label="Hantar gambar">${icon('image')}<input type="file" accept="image/*" hidden data-change="sendImage" data-id="${chat.id}"></label>
          <textarea class="input" name="body" rows="1" maxlength="2000" placeholder="Tulis mesej…" id="msgInput"></textarea>
          <button class="btn btn-primary btn-icon" type="submit" aria-label="Hantar">${icon('send')}</button>
        </form>
      </div>`;
    after = () => {
      state.activeChat = chat.id;
      const box = document.getElementById('msgs');
      box.scrollTop = box.scrollHeight;
      const input = document.getElementById('msgInput');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('composer').requestSubmit(); }
      });
      input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
      if (matchMedia('(min-width: 900px)').matches) input.focus();
      if (chat.unread) markRead(chat);
    };
  }

  onPage('uh:message', (e) => {
    const m = e.detail;
    if (state.activeChat === m.conversation_id) {
      const box = document.getElementById('msgs');
      if (box && !box.querySelector(`[data-mid="${m.id}"]`)) {
        const last = box.querySelector('.msg:last-of-type');
        const lastDay = last ? fmtDate(Number(last.dataset.at || Date.now())) : null;
        box.insertAdjacentHTML('beforeend', bubble(m, lastDay));
        box.scrollTop = box.scrollHeight;
      }
      if (m.sender_id !== state.me.id) api('POST', `/api/chats/${m.conversation_id}/read`).catch(() => {});
    }
    refreshList();
  });
  onPage('uh:read', (e) => {
    if (e.detail.conversation_id === state.activeChat) document.querySelectorAll('.msg.me [data-read]').forEach((el) => { el.textContent = '✓✓'; });
  });

  const html = `
    <div class="card chat-shell ${id ? 'has-active' : ''}">
      <aside class="chat-list" id="chatList">
        <div class="card-head" style="position:sticky;top:0;background:var(--surface);z-index:1"><b>Perbualan</b>${state.me.role === 'admin' ? '' : `<button class="btn btn-ghost btn-sm" data-act="openSupport">${icon('headset')} Sokongan</button>`}</div>
        ${chatList(chats, Number(id))}
      </aside>
      ${pane}
    </div>`;
  return { html, after };
}

async function markRead(chat) {
  await api('POST', `/api/chats/${chat.id}/read`);
  state.unread.chat = Math.max(0, state.unread.chat - chat.unread);
  hooks.renderShell();
  const row = document.querySelector(`[data-chat="${chat.id}"] .unread-n`);
  row?.remove();
}

async function refreshList() {
  const list = document.getElementById('chatList');
  if (!list) return;
  const { chats } = await api('GET', '/api/chats');
  const head = list.firstElementChild.outerHTML;
  list.innerHTML = head + chatList(chats, state.activeChat);
}

page('/chat', () => render(null), { auth: true });
page('/chat/:id', ({ id }) => render(id), { auth: true });

forms.sendMsg = async (data, form) => {
  const body = (data.body || '').trim();
  if (!body) return;
  const input = form.querySelector('textarea');
  input.value = '';
  input.style.height = 'auto';
  try {
    await api('POST', `/api/chats/${form.dataset.id}/messages`, { body });
  } catch (err) {
    input.value = body;
    throw err;
  }
  input.focus();
};
changes.sendImage = async (el) => {
  const file = el.files?.[0];
  if (!file) return;
  toast('Memuat naik gambar…', 'info', { timeout: 1500 });
  try {
    const url = await uploadImage(file, 1600);
    await api('POST', `/api/chats/${el.dataset.id}/messages`, { image: url, body: '' });
  } finally {
    el.value = '';
  }
};
