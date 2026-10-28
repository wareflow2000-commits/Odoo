// ============================================================================
// OW — real team chat (public channels, authenticated senders, Realtime)
// ============================================================================
import { tx, friendlyError, isAr } from './core-i18n.js';
import { sb } from './core-supabase.js';
import { store } from './core-store.js';
import { toast } from './core-toast.js';
import { playSound } from './core-sound.js';
import { promptDialog } from './core-modal.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const state = {
  client: null,
  channels: [],
  currentId: null,
  messages: [],
  realtime: null,
  page: null,
  sending: false
};

function cleanup() {
  if (state.realtime && state.client) {
    try { state.client.removeChannel(state.realtime); } catch (_) {}
  }
  state.realtime = null;
  state.page = null;
}

async function client() {
  if (!state.client) state.client = await sb();
  return state.client;
}

function currentUser() {
  const id = window.__session?.id || null;
  const profile = store.byId('profiles', id) || window.__session?.profile || {};
  const name = profile.name || profile.full_name || window.__session?.name
    || profile.email || window.__session?.email || tx('مستخدم', 'User');
  return { id, name, profile };
}

function initials(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2)
    .map(part => part[0] || '').join('').toUpperCase() || 'U';
}

function avatarColor(seed) {
  const palette = ['#714B67', '#017e84', '#a24689', '#b26a00', '#2f6fed', '#287d3c', '#7b4bb7', '#b03030'];
  let hash = 0;
  for (const ch of String(seed || 'U')) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  try {
    return d.toLocaleString(isAr() ? 'ar-EG' : 'en-GB', {
      numberingSystem: 'latn',
      ...(sameDay
        ? { hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    });
  } catch (_) {
    return d.toLocaleString();
  }
}

function channelName(channel) {
  return channel?.name || tx('قناة', 'Channel');
}

function renderChannels() {
  const box = state.page?.querySelector('#discussChannels');
  if (!box) return;
  if (!state.channels.length) {
    box.innerHTML = `<div class="o_discuss_empty_side">${tx('لا توجد قنوات بعد.', 'No channels yet.')}</div>`;
    return;
  }
  box.innerHTML = state.channels.map(channel => `
    <button type="button" class="o_discuss_channel ${channel.id === state.currentId ? 'active' : ''}"
      data-channel="${esc(channel.id)}">
      <i class="fa-solid fa-hashtag"></i>
      <span>${esc(channelName(channel))}</span>
    </button>`).join('');
  box.querySelectorAll('[data-channel]').forEach(btn => {
    btn.onclick = () => selectChannel(btn.dataset.channel);
  });
}

function renderHeader() {
  const channel = state.channels.find(c => c.id === state.currentId);
  const title = state.page?.querySelector('#discussTitle');
  const sub = state.page?.querySelector('#discussSubtitle');
  if (title) title.innerHTML = `<i class="fa-solid fa-hashtag"></i> ${esc(channelName(channel))}`;
  if (sub) sub.textContent = channel?.description || tx('محادثة الفريق', 'Team conversation');
}

function messageHtml(message) {
  const sender = store.byId('profiles', message.sender_id) || {};
  const name = sender.name || sender.full_name || sender.email || tx('مستخدم', 'User');
  const self = message.sender_id === currentUser().id;
  return `<div class="o_discuss_msg ${self ? 'is_self' : ''}" data-message="${esc(message.id)}">
    <span class="o_avatar" style="background:${avatarColor(message.sender_id)}">${esc(initials(name))}</span>
    <div class="o_discuss_msg_body">
      <div class="o_discuss_msg_meta">
        <b>${esc(self ? tx('أنت', 'You') : name)}</b>
        <span>${esc(fmtTime(message.created_at))}</span>
        ${message.edited_at ? `<span class="o_discuss_edited">${tx('معدّلة', 'edited')}</span>` : ''}
      </div>
      <div class="o_discuss_msg_text">${esc(message.body).replace(/\n/g, '<br>')}</div>
    </div>
  </div>`;
}

function renderMessages({ scroll = false } = {}) {
  const feed = state.page?.querySelector('#discussFeed');
  if (!feed) return;
  if (!state.currentId) {
    feed.innerHTML = `<div class="o_discuss_empty">${tx('اختر قناة لبدء المحادثة.', 'Select a channel to start chatting.')}</div>`;
    return;
  }
  if (!state.messages.length) {
    feed.innerHTML = `<div class="o_discuss_empty">
      <i class="fa-regular fa-comments"></i>
      <p>${tx('لا توجد رسائل في هذه القناة بعد. اكتب أول رسالة.', 'No messages in this channel yet. Write the first one.')}</p>
    </div>`;
    return;
  }
  feed.innerHTML = state.messages.map(messageHtml).join('');
  if (scroll) feed.scrollTop = feed.scrollHeight;
}

function showError(message) {
  const box = state.page?.querySelector('#discussError');
  if (!box) return;
  box.innerHTML = message ? `<div class="o_alert o_alert_danger">${esc(message)}</div>` : '';
}

async function loadChannels() {
  const c = await client();
  const { data, error } = await c.from('chat_channels')
    .select('id,name,description,kind,created_by,created_at')
    .eq('is_archived', false)
    .order('name', { ascending: true });
  if (error) throw error;
  state.channels = data || [];
  if (!state.channels.some(ch => ch.id === state.currentId)) {
    state.currentId = state.channels[0]?.id || null;
  }
  renderChannels();
  renderHeader();
}

async function loadMessages({ scroll = true } = {}) {
  if (!state.currentId) { renderMessages(); return; }
  const c = await client();
  const { data, error } = await c.from('chat_messages')
    .select('id,channel_id,sender_id,body,created_at,edited_at')
    .eq('channel_id', state.currentId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(400);
  if (error) throw error;
  state.messages = (data || []).slice().reverse();
  renderMessages({ scroll });
}

async function selectChannel(channelId) {
  if (!channelId || state.currentId === channelId) return;
  state.currentId = channelId;
  state.messages = [];
  renderChannels();
  renderHeader();
  renderMessages();
  try {
    await loadMessages({ scroll: true });
  } catch (error) {
    showError(friendlyError(error));
  }
}

async function sendMessage() {
  const input = state.page?.querySelector('#discussInput');
  const send = state.page?.querySelector('#discussSend');
  if (!input || state.sending || !state.currentId) return;
  const body = String(input.value || '').trim();
  if (!body) return;
  if (body.length > 4000) {
    toast(tx('الرسالة أطول من 4000 حرف.', 'The message is longer than 4000 characters.'), 'warning');
    return;
  }
  state.sending = true;
  if (send) send.disabled = true;
  input.disabled = true;
  try {
    const c = await client();
    const user = currentUser();
    const { error } = await c.from('chat_messages').insert({
      channel_id: state.currentId,
      sender_id: user.id,
      body
    });
    if (error) throw error;
    input.value = '';
    showError('');
    await loadMessages({ scroll: true });
  } catch (error) {
    input.value = body;
    showError(friendlyError(error));
    toast(friendlyError(error), 'error');
  } finally {
    state.sending = false;
    if (send) send.disabled = false;
    input.disabled = false;
    input.focus({ preventScroll: true });
  }
}

async function createChannel() {
  const name = await promptDialog({
    title: tx('قناة جديدة', 'New channel'),
    label: tx('اسم القناة', 'Channel name'),
    placeholder: tx('مثال: الصيانة اليومية', 'Example: daily maintenance'),
    confirmText: tx('إنشاء', 'Create')
  });
  if (!name) return;
  try {
    const c = await client();
    const user = currentUser();
    const { error } = await c.from('chat_channels').insert({
      name: String(name).trim(),
      kind: 'PUBLIC',
      created_by: user.id
    });
    if (error) throw error;
    await loadChannels();
    const created = state.channels.find(ch => String(ch.name).toLowerCase() === String(name).trim().toLowerCase());
    if (created) await selectChannel(created.id);
    toast(tx('تم إنشاء القناة.', 'Channel created.'), 'success');
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function subscribeRealtime() {
  const c = await client();
  if (state.realtime) {
    try { c.removeChannel(state.realtime); } catch (_) {}
  }
  state.realtime = c.channel('ow-team-chat')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages' }, payload => {
      const row = payload.new || payload.old || {};
      if (payload.eventType === 'INSERT' && row.sender_id && row.sender_id !== currentUser().id) {
        playSound('message');
      }
      if (row.channel_id && row.channel_id !== state.currentId) return;
      loadMessages({ scroll: true }).catch(() => {});
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_channels' }, () => {
      loadChannels().catch(() => {});
    })
    .subscribe();
}

export default {
  name: 'discuss',
  get brand() {
    return { name: tx('المناقشات', 'Discuss'), icon: 'fa-regular fa-comments' };
  },
  get menu() {
    return [{ label: tx('المناقشات', 'Discuss'), page: 'discuss' }];
  },
  render() {
    return `
      <style>
        .o_discuss_layout{display:flex;height:calc(100vh - 84px);min-height:420px;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
        .o_discuss_side{width:270px;flex-shrink:0;border-inline-end:1px solid #e3e6ea;background:#fafbfc;display:flex;flex-direction:column}
        .o_discuss_side_head{padding:14px 16px;border-bottom:1px solid #e3e6ea;display:flex;justify-content:space-between;align-items:center}
        .o_discuss_side_head h3{margin:0;font-size:14px;font-weight:700;color:#374151}
        .o_discuss_side_head button{border:none;background:#714B67;color:#fff;width:28px;height:28px;border-radius:6px;cursor:pointer}
        .o_discuss_side_label{padding:12px 16px 6px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em}
        #discussChannels{padding-bottom:10px;overflow-y:auto}
        .o_discuss_channel{width:100%;border:none;background:transparent;text-align:start;padding:9px 16px;display:flex;gap:9px;align-items:center;font-size:13px;color:#4b5563;cursor:pointer}
        .o_discuss_channel i{color:#9ca3af;font-size:12px}
        .o_discuss_channel:hover{background:#f1f3f5}
        .o_discuss_channel.active{background:#ede7ec;color:#714B67;font-weight:700}
        .o_discuss_channel.active i{color:#714B67}
        .o_discuss_empty_side{padding:18px 16px;font-size:12px;color:#9ca3af}
        .o_discuss_main{flex:1;display:flex;flex-direction:column;min-width:0}
        .o_discuss_head{padding:12px 20px;border-bottom:1px solid #e3e6ea;display:flex;justify-content:space-between;gap:10px;align-items:center}
        .o_discuss_head h3{margin:0;font-size:14px;font-weight:700;color:#374151}
        .o_discuss_head h3 i{color:#714B67;margin-inline-end:6px}
        .o_discuss_head small{display:block;color:#9ca3af;font-size:11px;margin-top:2px}
        #discussError{padding:0 20px}
        #discussError:not(:empty){padding-top:10px}
        #discussFeed{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:14px;background:#fff}
        .o_discuss_msg{display:flex;gap:10px;align-items:flex-start}
        .o_discuss_msg_body{min-width:0;max-width:min(680px,82%)}
        .o_discuss_msg_meta{display:flex;gap:8px;align-items:baseline;font-size:12px;color:#374151;margin-bottom:3px}
        .o_discuss_msg_meta b{font-weight:700}
        .o_discuss_msg_meta span{font-weight:400;color:#9ca3af;font-size:11px}
        .o_discuss_edited{font-style:italic}
        .o_discuss_msg_text{font-size:13px;color:#374151;line-height:1.65;white-space:pre-wrap;word-break:break-word;background:#f6f7f9;border:1px solid #eef0f2;border-radius:9px;padding:8px 11px}
        .o_discuss_msg.is_self .o_discuss_msg_text{background:#f3edf2;border-color:#e7dce4}
        .o_discuss_empty{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#9ca3af;font-size:13px;text-align:center;gap:8px}
        .o_discuss_empty i{font-size:32px;color:#d4c3d0}
        .o_discuss_composer{padding:12px 20px 16px;border-top:1px solid #eef0f2}
        .o_discuss_composer_box{display:flex;align-items:center;gap:10px;border:1px solid #dfe3e8;border-radius:8px;padding:8px 12px;background:#fff}
        .o_discuss_composer_box:focus-within{border-color:#714B67;box-shadow:0 0 0 2px rgba(113,75,103,.12)}
        #discussInput{flex:1;border:none;outline:none;font-size:13px;background:transparent;min-width:0}
        #discussSend{border:none;background:#714B67;color:#fff;width:34px;height:34px;border-radius:7px;cursor:pointer;flex-shrink:0}
        #discussSend:disabled{opacity:.45;cursor:wait}
        .o_discuss_hint{font-size:11px;color:#9ca3af;margin-top:6px}
        @media(max-width:760px){
          .o_discuss_layout{height:calc(100vh - 150px);border-radius:0;border-inline:0}
          .o_discuss_side{width:180px}
          #discussFeed{padding:14px}
          .o_discuss_msg_body{max-width:88%}
        }
      </style>
      <div class="o_discuss_layout">
        <aside class="o_discuss_side">
          <div class="o_discuss_side_head">
            <h3>${tx('المناقشات', 'Discuss')}</h3>
            <button type="button" id="discussNewChannel" title="${tx('قناة جديدة', 'New channel')}"><i class="fa-solid fa-plus"></i></button>
          </div>
          <div class="o_discuss_side_label">${tx('القنوات', 'Channels')}</div>
          <div id="discussChannels"></div>
        </aside>
        <main class="o_discuss_main">
          <div class="o_discuss_head">
            <div><h3 id="discussTitle"><i class="fa-solid fa-hashtag"></i></h3><small id="discussSubtitle">${tx('محادثة الفريق', 'Team conversation')}</small></div>
            <span class="o_badge o_badge_green"><i class="fa-solid fa-circle" style="font-size:7px"></i> ${tx('مباشر', 'Live')}</span>
          </div>
          <div id="discussError"></div>
          <div id="discussFeed"></div>
          <div class="o_discuss_composer">
            <div class="o_discuss_composer_box">
              <input id="discussInput" maxlength="4000" autocomplete="off" placeholder="${tx('اكتب رسالة...', 'Write a message...')}">
              <button type="button" id="discussSend" title="${tx('إرسال', 'Send')}"><i class="fa-solid fa-paper-plane"></i></button>
            </div>
            <div class="o_discuss_hint">${tx('تظهر الرسائل لجميع المستخدمين النشطين مباشرة.', 'Messages are delivered live to all active users.')}</div>
          </div>
        </main>
      </div>`;
  },
  async mount(_params, main) {
    cleanup();
    state.page = main;
    const input = main.querySelector('#discussInput');
    const send = main.querySelector('#discussSend');
    if (send) send.onclick = () => sendMessage();
    if (input) input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    const newChannel = main.querySelector('#discussNewChannel');
    if (newChannel) newChannel.onclick = () => createChannel();

    const onHash = () => { if (OW.currentPage !== 'discuss') cleanup(); };
    window.addEventListener('hashchange', onHash);

    renderMessages();
    try {
      await loadChannels();
      if (state.currentId) await loadMessages({ scroll: true });
      await subscribeRealtime();
      input?.focus({ preventScroll: true });
    } catch (error) {
      showError(friendlyError(error));
      toast(friendlyError(error), 'error');
    }
  }
};
