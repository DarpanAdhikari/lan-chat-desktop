const { api } = window;

// ─── State ─────────────────────────────────────────────
let myConfig = {};
let friends = [];
let groups = [];
let nearbyPeers = new Map();
let activeConversation = null;
let replyToMsg = null;
let typingTimer = null;
let setupColor = '#6366f1';
let selectedMessages = new Set();
let isSelectMode = false;
let themeMediaQuery = null;

// Unread / last-message tracking
let unreadCounts = {};
let lastMessages = {};

// WebRTC state
let localStream = null;
let screenStream = null;
let peerConnection = null;
let callFriendId = null;
let callIncoming = null;
let currentCallType = null; // 'video' | 'audio' | 'screen'
let isMuted = false;
let isCamOff = false;
let isScreenSharing = false;
let pendingIceCandidates = [];
let currentSearchResults = [];
let currentSearchIndex = -1;

// ── Annotation: per-user layers ──────────────────────────
// annotationLayers: Map<userId, { canvas, ctx, lastX, lastY }>
let annotationLayers = new Map();
let isDrawing = false;
let drawColor = '#ff3b3b';
let drawSize = 3;
let annotationEnabled = false;
let annotationContainer = null; // the wrap element annotations go into

// Speech recognition for captions
let recognition = null;
let captionActive = false;

// ── Drag-and-drop file staging ───────────────────────────
// stagedFiles: Array<{ path, name, size, isDir, previewUrl }>
let stagedFiles = [];
let dragDepth = 0; // track nested dragenter/dragleave

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

function supportsWebRTC() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
}

function getMediaErrorMessage(error, defaultMsg) {
  if (!error) return defaultMsg;
  if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
    return 'Permission denied. Allow camera/microphone access in system settings.';
  }
  if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
    return 'No camera or microphone was found. Check your device settings.';
  }
  if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
    return 'Your camera or microphone is currently in use by another application.';
  }
  return error.message || defaultMsg;
}

function updateCallButtonState() {
  const callBtn = document.getElementById('call-btn');
  const audioBtn = document.getElementById('audio-call-btn');
  if (!callBtn || !audioBtn) return;

  const enabled = activeConversation?.type === 'friend' && supportsWebRTC();
  callBtn.style.display = activeConversation?.type === 'friend' ? 'flex' : 'none';
  audioBtn.style.display = activeConversation?.type === 'friend' ? 'flex' : 'none';
  callBtn.disabled = !enabled;
  audioBtn.disabled = !enabled;
  callBtn.title = enabled ? 'Video Call' : 'Video calls unavailable';
  audioBtn.title = enabled ? 'Audio Call' : 'Audio calls unavailable';
}

function getConversationMuteState() {
  if (!activeConversation) return false;
  if (activeConversation.type === 'friend') {
    return !!myConfig.mutedChats?.[activeConversation.id];
  }
  if (activeConversation.type === 'group') {
    return !!myConfig.mutedGroups?.[activeConversation.id];
  }
  return false;
}

function updateChatMenuNotificationState() {
  const btn = document.getElementById('menu-toggle-notif');
  if (!btn) return;
  if (!activeConversation) {
    btn.textContent = '🔕 Mute Notifications';
    btn.disabled = true;
    return;
  }
  const muted = getConversationMuteState();
  btn.textContent = muted ? '🔔 Enable Notifications' : '🔕 Mute Notifications';
  btn.disabled = false;
}

async function toggleConversationNotifications() {
  if (!activeConversation) return;
  myConfig.mutedChats = myConfig.mutedChats || {};
  myConfig.mutedGroups = myConfig.mutedGroups || {};
  const isMuted = getConversationMuteState();
  if (activeConversation.type === 'friend') {
    myConfig.mutedChats[activeConversation.id] = !isMuted;
  } else if (activeConversation.type === 'group') {
    myConfig.mutedGroups[activeConversation.id] = !isMuted;
  }
  await api.updateConfig({ mutedChats: myConfig.mutedChats, mutedGroups: myConfig.mutedGroups });
  updateChatMenuNotificationState();
  showInAppNotif(isMuted ? 'Notifications enabled' : 'Notifications muted', isMuted ? 'Desktop alerts will now appear for this conversation.' : 'Desktop alerts are turned off for this conversation.');
}

async function requestMediaPermissions(callType) {
  try {
    let stream = null;
    if (callType === 'audio') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      showInAppNotif('Permissions Granted', 'Microphone access granted. You can now start the audio call.');
    } else if (callType === 'video') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      showInAppNotif('Permissions Granted', 'Camera and microphone access granted. You can now start the video call.');
    } else {
      showInAppNotif('Screen Share', 'Screen share permissions are requested when starting a screen share call.');
    }
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
  } catch (e) {
    showInAppNotif('Permission Required', getMediaErrorMessage(e, 'Permission denied or unavailable.'));
  }
}

function showPermissionModal(callType) {
  document.getElementById('permission-modal')?.remove();
  const typeLabel = callType === 'audio' ? 'audio' : callType === 'screen' ? 'screen sharing' : 'video';
  const detail = callType === 'screen'
    ? 'Screen sharing permission is requested when you start a screen share call.'
    : 'LocalChat needs access to your camera and microphone to place this call.';

  const modal = document.createElement('div');
  modal.id = 'permission-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <h3>Enable ${typeLabel}</h3>
      <p style="margin-top:0.5rem;line-height:1.5;">${detail}</p>
      <div class="modal-actions" style="margin-top:16px;justify-content:center;">
        <button class="primary-btn" id="permission-request-btn">Request Permission</button>
        <button class="modal-cancel" id="permission-cancel-btn">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('permission-request-btn').addEventListener('click', async () => {
    modal.remove();
    await requestMediaPermissions(callType);
  });
  document.getElementById('permission-cancel-btn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

function clearChatSearchHighlights() {
  currentSearchResults = [];
  currentSearchIndex = -1;
  document.querySelectorAll('#messages .msg-wrap.search-hit').forEach(el => {
    el.classList.remove('search-hit', 'search-current');
  });
}

function openChatSearchModal() {
  if (!activeConversation) return;
  document.getElementById('chat-search-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'chat-search-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <h3>Search Messages</h3>
      <input type="text" id="chat-search-input" placeholder="Search this conversation..." autocomplete="off">
      <div class="modal-actions">
        <button class="primary-btn" id="chat-search-go">Search</button>
        <button class="modal-cancel" id="chat-search-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const inputEl = document.getElementById('chat-search-input');
  inputEl.focus();
  const doSearch = () => {
    const query = inputEl.value.trim();
    performChatSearch(query);
    if (query && currentSearchResults.length > 0) {
      showInAppNotif('Search Results', `${currentSearchResults.length} match${currentSearchResults.length === 1 ? '' : 'es'} found.`);
    }
    modal.remove();
  };

  document.getElementById('chat-search-go').addEventListener('click', doSearch);
  document.getElementById('chat-search-close').addEventListener('click', () => modal.remove());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function performChatSearch(query) {
  clearChatSearchHighlights();
  if (!query) {
    showInAppNotif('Search', 'Search cleared.');
    return;
  }

  const normalized = query.toLowerCase();
  const matches = [];
  document.querySelectorAll('#messages .msg-wrap').forEach(wrap => {
    const bubble = wrap.querySelector('.msg-bubble');
    if (!bubble) return;
    const text = bubble.textContent.toLowerCase();
    if (text.includes(normalized)) {
      wrap.classList.add('search-hit');
      matches.push(wrap);
    }
  });

  if (matches.length === 0) {
    showInAppNotif('No Results', `No matches found for "${query}".`);
    return;
  }

  currentSearchResults = matches;
  currentSearchIndex = 0;
  scrollToSearchResult(0);
}

function scrollToSearchResult(index) {
  if (index < 0 || index >= currentSearchResults.length) return;
  currentSearchResults.forEach((wrap, idx) => {
    wrap.classList.toggle('search-current', idx === index);
  });
  const element = currentSearchResults[index];
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  currentSearchIndex = index;
}

const EMOJIS = ['😀','😂','😍','😎','😢','😡','👍','👎','❤️','🔥','✅','⭐','🎉','👋','🙏','💯','😅','🤔','😴','🥳','🤩','😮','😱','🤗','😏','🤝','💪','🎯','📎','🔗','👏','🫡','😜','🤣','😇','🥰','😬','🙄','💀','✨'];
const QUICK_REACTIONS = ['👍','❤️','😂','😮','😢','🔥'];

// ─── Init ───────────────────────────────────────────────
(async () => {
  myConfig = await api.getConfig();
  if (!myConfig.name) {
    showSetupModal();
  } else {
    applyThemeColor(myConfig.color);
    applyThemeMode(myConfig.themeMode || 'system');
    await loadAll();
  }
  setupEventListeners();
  setupIPCListeners();
  buildEmojiPicker();
})();

async function loadAll() {
  myConfig = await api.getConfig();
  applyThemeColor(myConfig.color);
  applyThemeMode(myConfig.themeMode || 'system');
  renderMyProfile();
  friends = await api.getFriends();
  groups = await api.getGroups();
  await preloadLastMessages();
  renderChatList();
  renderGroupList();
  renderRequests();
  updateSettingsPanel();
}

async function preloadLastMessages() {
  for (const f of friends) {
    try {
      const history = await api.getChat(f.id);
      if (history && history.length > 0) {
        const last = history[history.length - 1];
        lastMessages[f.id] = { text: last.type === 'file' ? `📎 ${last.fileName}` : (last.text || ''), time: last.time, from: last.from };
      }
    } catch(e) {}
  }
}

// ─── Theme ──────────────────────────────────────────────
function applyThemeColor(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-dim', color + '33');
}

function handleSystemThemeChange() {
  applyThemeMode('system');
}

function applyThemeMode(mode) {
  const theme = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  document.documentElement.classList.toggle('theme-light', theme === 'light');
  document.documentElement.classList.toggle('theme-dark', theme === 'dark');

  if (themeMediaQuery) {
    themeMediaQuery.removeEventListener('change', handleSystemThemeChange);
    themeMediaQuery = null;
  }
  if (mode === 'system') {
    themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    themeMediaQuery.addEventListener('change', handleSystemThemeChange);
  }
}

// ─── Setup Modal ─────────────────────────────────────────
function showSetupModal() {
  document.getElementById('setup-modal').classList.remove('hidden');
  document.getElementById('setup-name').focus();
}

function setupSetupModal() {
  const nameInput = document.getElementById('setup-name');
  const submitBtn = document.getElementById('setup-submit');
  const swatches = document.querySelectorAll('#setup-color-row .swatch');
  const preview = document.getElementById('setup-avatar-preview');
  const initials = document.getElementById('setup-avatar-initials');

  nameInput.addEventListener('input', () => {
    const n = nameInput.value.trim();
    initials.textContent = n ? n.charAt(0).toUpperCase() : '?';
  });

  swatches.forEach(s => {
    s.addEventListener('click', () => {
      swatches.forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      setupColor = s.dataset.color;
      preview.style.background = setupColor;
      applyThemeColor(setupColor);
    });
  });

  preview.style.background = setupColor;

  submitBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    myConfig = await api.updateConfig({ name, color: setupColor });
    document.getElementById('setup-modal').classList.add('hidden');
    await loadAll();
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBtn.click();
  });
}

// ─── My Profile ──────────────────────────────────────────
function renderMyProfile() {
  document.getElementById('my-name').textContent = myConfig.name || 'You';
  const statusMap = { Available:'🟢', Busy:'🔴', Away:'🟡', 'Do Not Disturb':'⛔', Invisible:'👻' };
  document.getElementById('my-status').textContent = (statusMap[myConfig.status] || '🟢') + ' ' + (myConfig.status || 'Available');
  const av = document.getElementById('my-avatar');
  renderAvatarEl(av, myConfig.name, myConfig.color, myConfig.avatar, 36);
}

function renderAvatarEl(el, name, color, avatarData, size = 36) {
  el.innerHTML = '';
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:${Math.round(size*0.4)}px;flex-shrink:0;`;
  if (avatarData) {
    const img = document.createElement('img');
    img.src = avatarData;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    el.appendChild(img);
  } else {
    el.style.background = color || '#6366f1';
    el.style.color = '#fff';
    el.textContent = (name || '?').charAt(0).toUpperCase();
  }
}

// ─── Chat List ──────────────────────────────────────────
function renderChatList(filter = '') {
  const el = document.getElementById('chats-list');
  el.innerHTML = '';
  const filtered = friends.filter(f => f.name.toLowerCase().includes(filter.toLowerCase()));

  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty-list">No friends yet.<br>Explore Nearby to connect.</div>';
    return;
  }

  const sorted = [...filtered].sort((a, b) => {
    const ta = lastMessages[a.id]?.time || 0;
    const tb = lastMessages[b.id]?.time || 0;
    return tb - ta;
  });

  sorted.forEach(f => {
    const online = nearbyPeers.has(f.id);
    const isActive = activeConversation?.type === 'friend' && activeConversation?.id === f.id;
    const unread = !isActive ? (unreadCounts[f.id] || 0) : 0;
    const last = lastMessages[f.id];
    // Is this friend currently in a call with us?
    const inCall = callFriendId === f.id && peerConnection;

    const div = document.createElement('div');
    div.className = 'list-item' + (isActive ? ' active' : '');
    div.dataset.id = f.id;

    const av = document.createElement('div');
    av.className = 'item-avatar';
    renderAvatarEl(av, f.name, f.color, f.avatar, 40);

    // Calling animation badge
    if (inCall) {
      const callBadge = document.createElement('div');
      callBadge.className = 'call-ring-badge';
      callBadge.innerHTML = currentCallType === 'audio' ? '📞' : '📹';
      av.appendChild(callBadge);
    }

    const statusDot = document.createElement('div');
    statusDot.className = 'status-dot ' + (online ? 'online' : 'offline');

    const info = document.createElement('div');
    info.className = 'item-info';

    let lastMsgHtml = '';
    if (inCall) {
      lastMsgHtml = `<div class="item-last-msg call-active-label">● ${currentCallType === 'audio' ? 'Audio' : currentCallType === 'screen' ? 'Screen share' : 'Video'} call in progress</div>`;
    } else if (last) {
      const fromPrefix = last.from === 'me' ? 'You: ' : '';
      const truncated = (last.text || '').substring(0, 35) + ((last.text || '').length > 35 ? '…' : '');
      lastMsgHtml = `<div class="item-last-msg">${escHtml(fromPrefix + truncated)}</div>`;
    } else {
      lastMsgHtml = `<div class="item-sub">${online ? (f.status || 'Online') : 'Offline'}</div>`;
    }

    info.innerHTML = `
      <div class="item-name-row">
        <div class="item-name">${escHtml(f.name)}</div>
        ${last && !inCall ? `<div class="item-time">${formatShortTime(last.time)}</div>` : ''}
      </div>
      ${lastMsgHtml}
    `;

    div.appendChild(av);
    div.appendChild(statusDot);
    div.appendChild(info);

    if (unread > 0) {
      const badge = document.createElement('div');
      badge.className = 'unread-badge';
      badge.textContent = unread > 99 ? '99+' : unread;
      div.appendChild(badge);
    }

    div.addEventListener('click', () => openFriendChat(f.id));
    el.appendChild(div);
  });
}

// ─── Group List ──────────────────────────────────────────
function renderGroupList(filter = '') {
  const el = document.getElementById('groups-list');
  el.innerHTML = '';

  if (groups.length === 0) {
    el.innerHTML = '<div class="empty-list">No groups yet.<br>Create one below.</div>';
    return;
  }

  groups.filter(g => g.name.toLowerCase().includes(filter.toLowerCase())).forEach(g => {
    const isActive = activeConversation?.type === 'group' && activeConversation?.id === g.id;
    const div = document.createElement('div');
    div.className = 'list-item' + (isActive ? ' active' : '');

    const av = document.createElement('div');
    av.className = 'item-avatar';
    av.style.cssText = `width:40px;height:40px;border-radius:12px;background:${g.color||'#6366f1'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0;`;
    av.textContent = g.name.charAt(0).toUpperCase();

    const info = document.createElement('div');
    info.className = 'item-info';
    info.innerHTML = `<div class="item-name">${escHtml(g.name)}</div>
      <div class="item-sub">${g.members.length} members</div>`;

    div.appendChild(av);
    div.appendChild(info);
    div.addEventListener('click', () => openGroupChat(g.id));
    el.appendChild(div);
  });
}

// ─── Nearby ──────────────────────────────────────────────
function renderNearby() {
  const el = document.getElementById('nearby-list');
  el.innerHTML = '';
  let count = 0;

  nearbyPeers.forEach((peer, id) => {
    const alreadyFriend = friends.some(f => f.id === id);
    if (alreadyFriend) return;
    count++;
    const div = document.createElement('div');
    div.className = 'list-item';

    const av = document.createElement('div');
    av.className = 'item-avatar';
    renderAvatarEl(av, peer.name, peer.color, null, 40);

    const info = document.createElement('div');
    info.className = 'item-info';
    info.innerHTML = `<div class="item-name">${escHtml(peer.name)}</div>
      <div class="item-sub">${peer.ip}</div>`;

    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.sendFriendRequest({ id: peer.id, ip: peer.ip, port: peer.wsPort });
      addBtn.textContent = 'Sent ✓';
      addBtn.disabled = true;
      switchTab('requests');
    });

    div.appendChild(av);
    div.appendChild(info);
    div.appendChild(addBtn);
    el.appendChild(div);
  });

  if (count === 0) {
    el.innerHTML = '<div class="empty-list">Scanning for nearby devices...</div>';
  }
}

// ─── Tab helper ──────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.list').forEach(l => l.classList.remove('active'));
  const btn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (btn) btn.classList.add('active');
  const list = document.getElementById(tabName + '-list');
  if (list) list.classList.add('active');
  if (tabName === 'requests') renderRequests();
}

// ─── Requests ────────────────────────────────────────────
async function renderRequests() {
  const el = document.getElementById('requests-list');
  el.innerHTML = '';
  const requests = await api.getFriendRequests();
  const pending = requests.filter(r => r.status === 'pending');

  const badge = document.getElementById('req-badge');
  if (pending.length > 0) {
    badge.textContent = pending.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  if (pending.length === 0) {
    el.innerHTML = '<div class="empty-list">No pending requests</div>';
    return;
  }

  pending.forEach(req => {
    const div = document.createElement('div');
    div.className = 'list-item request-item';

    const av = document.createElement('div');
    av.className = 'item-avatar';
    renderAvatarEl(av, req.fromName, req.fromColor, null, 40);

    const info = document.createElement('div');
    info.className = 'item-info';
    info.innerHTML = `<div class="item-name">${escHtml(req.fromName)}</div>
      <div class="item-sub">Wants to connect</div>`;

    const actions = document.createElement('div');
    actions.className = 'req-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'accept-btn';
    acceptBtn.textContent = '✓';
    acceptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.acceptFriendRequest(req.fromId);
      div.remove();
    });

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject-btn';
    rejectBtn.textContent = '✕';
    rejectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.rejectFriendRequest(req.fromId);
      div.remove();
    });

    actions.appendChild(acceptBtn);
    actions.appendChild(rejectBtn);
    div.appendChild(av);
    div.appendChild(info);
    div.appendChild(actions);
    el.appendChild(div);
  });
}

// ─── Open Conversations ─────────────────────────────────
async function openFriendChat(friendId) {
  exitSelectMode();
  clearStagedFiles();
  dragDepth = 0;
  unreadCounts[friendId] = 0;
  activeConversation = { type: 'friend', id: friendId };
  const friend = friends.find(f => f.id === friendId);
  if (!friend) return;

  showChatView();
  updateChatMenuNotificationState();
  clearChatSearchHighlights();
  renderChatList();

  const topbarAv = document.getElementById('topbar-avatar');
  renderAvatarEl(topbarAv, friend.name, friend.color, friend.avatar, 36);
  document.getElementById('topbar-name').textContent = friend.name;
  const online = nearbyPeers.has(friendId);
  document.getElementById('topbar-status').textContent = online ? (friend.status || 'Online') : 'Offline';

  updateCallButtonState();

  document.getElementById('topbar-avatar').style.cursor = 'pointer';
  document.getElementById('topbar-avatar').onclick = () => showFriendProfile(friendId);
  document.getElementById('topbar-name').style.cursor = 'pointer';
  document.getElementById('topbar-name').onclick = () => showFriendProfile(friendId);

  const history = await api.getChat(friendId);
  renderMessages(history, false);
  api.markRead(friendId);

  if (history.length > 0) {
    const last = history[history.length - 1];
    lastMessages[friendId] = { text: last.type === 'file' ? `📎 ${last.fileName}` : (last.text || ''), time: last.time, from: last.from };
  }

  document.getElementById('msg-input').focus();
}

async function openGroupChat(groupId) {
  exitSelectMode();
  clearStagedFiles();
  dragDepth = 0;
  activeConversation = { type: 'group', id: groupId };
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  showChatView();
  updateChatMenuNotificationState();
  clearChatSearchHighlights();
  renderGroupList();

  const topbarAv = document.getElementById('topbar-avatar');
  topbarAv.innerHTML = '';
  topbarAv.style.cssText = `width:36px;height:36px;border-radius:10px;background:${group.color};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0;cursor:default;`;
  topbarAv.onclick = null;
  topbarAv.textContent = group.name.charAt(0).toUpperCase();

  document.getElementById('topbar-name').textContent = group.name;
  document.getElementById('topbar-name').style.cursor = 'default';
  document.getElementById('topbar-name').onclick = () => showGroupMembers(groupId);

  updateCallButtonState();

  // Show member count + clickable to see list
  const memberCount = group.members.length;
  const topbarStatus = document.getElementById('topbar-status');
  topbarStatus.style.cursor = 'pointer';
  topbarStatus.textContent = memberCount + ' members — tap to view';
  topbarStatus.onclick = () => showGroupMembers(groupId);

  document.getElementById('call-btn').style.display = 'none';
  document.getElementById('audio-call-btn').style.display = 'none';

  const history = await api.getGroupChat(groupId);
  renderMessages(history, true);
  document.getElementById('msg-input').focus();
}

// ─── Group Members Modal ─────────────────────────────────
function showGroupMembers(groupId) {
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  document.getElementById('group-members-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'group-members-modal';
  modal.className = 'modal-overlay';

  const memberList = group.members.map(memberId => {
    if (memberId === myConfig.id) return { id: memberId, name: myConfig.name, color: myConfig.color, avatar: myConfig.avatar, isMe: true };
    return friends.find(f => f.id === memberId) || { id: memberId, name: memberId.substring(0, 8) + '…', color: '#888', isMe: false };
  });

  const membersHtml = memberList.map(m => {
    const online = nearbyPeers.has(m.id) || m.isMe;
    const avatarStyle = `width:36px;height:36px;border-radius:50%;background:${m.color||'#6366f1'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;`;
    const avatarContent = m.avatar ? `<img src="${m.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : (m.name||'?').charAt(0).toUpperCase();
    return `
      <div class="group-member-row">
        <div style="${avatarStyle}">${avatarContent}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;">${escHtml(m.name)}${m.isMe ? ' <span style="opacity:0.5;font-weight:400;">(you)</span>' : ''}</div>
          <div style="font-size:12px;opacity:0.6;">${online ? '🟢 Online' : '⚫ Offline'}</div>
        </div>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="modal-box" style="max-width:340px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;">${escHtml(group.name)}</h3>
        <button class="modal-close-btn" id="group-members-close">✕</button>
      </div>
      <p style="margin:0 0 12px;opacity:0.6;font-size:13px;">${group.members.length} members</p>
      <div style="max-height:320px;overflow-y:auto;">${membersHtml}</div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('group-members-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function showChatView() {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');
  document.getElementById('messages').innerHTML = '';
}

// ─── Friend Profile Modal ────────────────────────────────
function showFriendProfile(friendId) {
  const friend = friends.find(f => f.id === friendId);
  if (!friend) return;
  document.getElementById('profile-modal')?.remove();

  const online = nearbyPeers.has(friendId);
  const modal = document.createElement('div');
  modal.id = 'profile-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box profile-modal-box">
      <button class="modal-close-btn" id="profile-modal-close">✕</button>
      <div class="profile-modal-avatar" id="profile-modal-av"></div>
      <div class="profile-modal-name">${escHtml(friend.name)}</div>
      <div class="profile-modal-status">
        <span class="status-indicator ${online ? 'online' : 'offline'}">●</span>
        ${escHtml(friend.status || 'Available')}
        ${friend.statusMsg ? `<div class="profile-modal-msg">"${escHtml(friend.statusMsg)}"</div>` : ''}
      </div>
      <div class="profile-modal-id">ID: ${friend.id.substring(0,16)}...</div>
      <div class="profile-modal-actions">
        <button class="primary-btn" id="profile-msg-btn">💬 Message</button>
        <button class="danger-btn" id="profile-remove-btn">🗑 Remove Friend</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const avEl = document.getElementById('profile-modal-av');
  avEl.style.cssText = `width:80px;height:80px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:32px;margin:0 auto 12px;`;
  if (friend.avatar) {
    avEl.innerHTML = `<img src="${friend.avatar}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    avEl.style.background = friend.color || '#6366f1';
    avEl.style.color = '#fff';
    avEl.textContent = (friend.name || '?').charAt(0).toUpperCase();
  }

  document.getElementById('profile-modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById('profile-msg-btn').addEventListener('click', () => {
    modal.remove();
    openFriendChat(friendId);
  });

  document.getElementById('profile-remove-btn').addEventListener('click', () => {
    if (confirm(`Remove ${friend.name} from friends?`)) {
      api.removeFriend(friendId);
      modal.remove();
      if (activeConversation?.id === friendId) {
        activeConversation = null;
        document.getElementById('chat-view').classList.add('hidden');
        document.getElementById('empty-state').classList.remove('hidden');
      }
    }
  });
}

// ─── Messages Render ─────────────────────────────────────
function renderMessages(history, isGroup) {
  clearChatSearchHighlights();
  const el = document.getElementById('messages');
  el.innerHTML = '';
  history.forEach(msg => appendMessage(msg, isGroup));
  scrollToBottom();
}

function appendMessage(msg, isGroup = false) {
  const el = document.getElementById('messages');
  const isMe = isGroup ? msg.from === myConfig.id : msg.from === 'me';

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + (isMe ? 'me' : 'them');
  wrap.dataset.msgId = msg.id;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'msg-checkbox';
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    if (checkbox.checked) selectedMessages.add(msg.id);
    else selectedMessages.delete(msg.id);
    updateSelectBar();
  });
  wrap.appendChild(checkbox);

  // Add click handler to entire message to toggle checkbox in select mode
  wrap.addEventListener('click', (e) => {
    if (isSelectMode && e.target !== checkbox) {
      e.stopPropagation();
      checkbox.checked = !checkbox.checked;
      if (checkbox.checked) selectedMessages.add(msg.id);
      else selectedMessages.delete(msg.id);
      updateSelectBar();
    }
  });

  if (isGroup && !isMe) {
    const sender = friends.find(f => f.id === msg.from);
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    renderAvatarEl(av, msg.fromName || msg.from, msg.fromColor || sender?.color || '#6366f1', sender?.avatar, 28);
    wrap.appendChild(av);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (isGroup && !isMe) {
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-sender';
    nameEl.textContent = msg.fromName || msg.from;
    nameEl.style.color = msg.fromColor || '#6366f1';
    bubble.appendChild(nameEl);
  }

  if (msg.replyTo) {
    const replyEl = document.createElement('div');
    replyEl.className = 'msg-reply-preview';
    replyEl.innerHTML = `<span>↩ ${escHtml((msg.replyTo.text || '[file]').substring(0, 60))}</span>`;
    bubble.appendChild(replyEl);
  }

  if (msg.type === 'file') {
    bubble.appendChild(buildFileElement(msg, isMe, isGroup));
  } else {
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.innerHTML = linkify(escHtml(msg.text || ''));
    bubble.appendChild(textEl);
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  let statusIcon = '';
  if (isMe) {
    const s = msg.status || 'sent';
    const statusLabel = s === 'queued' ? '⏳' : s === 'read' ? '✓✓' : '✓';
    const statusTitle = s === 'queued' ? 'Will send when online' : s === 'sent' ? 'Sent' : 'Read';
    statusIcon = `<span class="msg-status" title="${statusTitle}">${statusLabel}</span>`;
  }
  meta.innerHTML = `<span class="msg-time">${formatTime(msg.time)}</span>${statusIcon}`;
  bubble.appendChild(meta);

  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    bubble.appendChild(buildReactionsEl(msg.reactions));
  }

  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMsgActions(e, msg, isGroup);
  });

  let pressTimer;
  bubble.addEventListener('touchstart', () => {
    pressTimer = setTimeout(() => showMsgActions({ clientX: 100, clientY: 200 }, msg, isGroup), 500);
  });
  bubble.addEventListener('touchend', () => clearTimeout(pressTimer));

  wrap.appendChild(bubble);
  el.appendChild(wrap);

  if (isSelectMode) wrap.classList.add('select-mode');
}

function buildFileElement(msg, isMe, isGroup) {
  const ext = (msg.fileName || '').split('.').pop().toLowerCase();
  const fileEl = document.createElement('div');
  fileEl.className = 'msg-file';
  fileEl.dataset.transferId = msg.id;

  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.textContent = getFileIcon(ext);

  const info = document.createElement('div');
  info.className = 'file-info';
  info.innerHTML = `<div class="file-name">${escHtml(msg.fileName)}</div>
    <div class="file-size">${formatSize(msg.fileSize)}</div>`;

  const progressWrap = document.createElement('div');
  progressWrap.className = 'file-progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'file-progress-fill';

  const isSending = msg.status === 'sending' || msg.status === 'queued';
  const isReceiving = !isMe && msg.status !== 'received';
  const showProgress = isSending || isReceiving;

  progressFill.style.width = showProgress ? '0%' : '100%';
  progressWrap.appendChild(progressFill);
  if (!showProgress) progressWrap.style.display = 'none';

  const statusLabel = document.createElement('div');
  statusLabel.className = 'file-status-label';
  if (msg.status === 'queued') {
    statusLabel.textContent = '⏳ Queued — will send when online';
    statusLabel.style.fontSize = '11px';
    statusLabel.style.opacity = '0.7';
    statusLabel.style.marginTop = '4px';
  } else if (isSending) {
    statusLabel.textContent = 'Sending... 0%';
  } else if (isReceiving) {
    statusLabel.textContent = 'Receiving... 0%';
  }

  const actions = document.createElement('div');
  actions.className = 'file-actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'file-btn';
  downloadBtn.title = 'Download';
  downloadBtn.innerHTML = '⬇';
  downloadBtn.disabled = showProgress;
  downloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const friendId = isGroup ? null : activeConversation?.id;
    api.downloadFile(friendId, msg.fileName, isMe);
  });

  const openBtn = document.createElement('button');
  openBtn.className = 'file-btn';
  openBtn.title = 'Open';
  openBtn.innerHTML = '↗';
  openBtn.disabled = showProgress;
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const friendId = isGroup ? null : activeConversation?.id;
    api.openFile(friendId, msg.fileName, isMe);
  });

  actions.appendChild(downloadBtn);
  actions.appendChild(openBtn);

  fileEl.appendChild(icon);
  fileEl.appendChild(info);
  fileEl.appendChild(progressWrap);
  if (statusLabel.textContent) fileEl.appendChild(statusLabel);
  fileEl.appendChild(actions);

  return fileEl;
}

function updateFileProgress(msgId, progress, friendId) {
  const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!wrap) return;

  const fileEl = wrap.querySelector('.msg-file');
  if (!fileEl) return;

  const fill = fileEl.querySelector('.file-progress-fill');
  const bar = fileEl.querySelector('.file-progress-bar');
  const label = fileEl.querySelector('.file-status-label');
  const btns = fileEl.querySelectorAll('.file-btn');
  const isMe = wrap.classList.contains('me');

  if (fill) fill.style.width = progress + '%';
  if (label) label.textContent = (isMe ? 'Sending... ' : 'Receiving... ') + progress + '%';

  if (progress >= 100) {
    if (bar) setTimeout(() => { bar.style.display = 'none'; }, 600);
    if (label) setTimeout(() => { label.remove(); }, 600);
    btns.forEach(btn => btn.disabled = false);
  }
}

function buildReactionsEl(reactions) {
  const reactEl = document.createElement('div');
  reactEl.className = 'msg-reactions';
  Object.entries(reactions).forEach(([emoji, count]) => {
    const span = document.createElement('span');
    span.className = 'reaction-chip';
    span.textContent = emoji + (count > 1 ? ' ' + count : '');
    reactEl.appendChild(span);
  });
  return reactEl;
}

// ─── Message Context Menu ────────────────────────────────
function showMsgActions(e, msg, isGroup) {
  document.querySelectorAll('.msg-action-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'msg-action-menu';

  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 220);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const reactBar = document.createElement('div');
  reactBar.className = 'quick-react-bar';
  QUICK_REACTIONS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.className = 'quick-react-btn';
    btn.addEventListener('click', () => {
      sendReaction(msg, isGroup, emoji);
      menu.remove();
    });
    reactBar.appendChild(btn);
  });
  menu.appendChild(reactBar);

  const divider = document.createElement('div');
  divider.className = 'menu-divider';
  menu.appendChild(divider);

  addMenuItem(menu, '↩ Reply', () => { setReply(msg); menu.remove(); });
  addMenuItem(menu, '☑ Select', () => { menu.remove(); enterSelectMode(msg.id); });
  
  // Forward is only available for text messages
  if (msg.type !== 'file') {
    addMenuItem(menu, '⤵ Forward', () => { menu.remove(); openForwardModal(msg, isGroup); });
  }

  const isMe = isGroup ? msg.from === myConfig.id : msg.from === 'me';
  if (isMe && msg.type !== 'file') {
    addMenuItem(menu, '📋 Copy', () => {
      navigator.clipboard.writeText(msg.text || '').catch(() => {});
      menu.remove();
    });
  }

  addMenuItem(menu, '🗑 Delete', () => {
    menu.remove();
    deleteSingleMessage(msg.id, isGroup);
  });

  document.body.appendChild(menu);

  setTimeout(() => {
    const handler = () => { menu.remove(); document.removeEventListener('click', handler); };
    document.addEventListener('click', handler);
  }, 50);
}

function addMenuItem(menu, text, onClick) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.addEventListener('click', () => onClick());
  menu.appendChild(btn);
}

async function deleteSingleMessage(msgId, isGroup) {
  if (!activeConversation) return;
  if (isGroup) {
    await api.deleteGroupMessages(activeConversation.id, [msgId]);
    const history = await api.getGroupChat(activeConversation.id);
    renderMessages(history, true);
  } else {
    await api.deleteMessages(activeConversation.id, [msgId]);
    const history = await api.getChat(activeConversation.id);
    renderMessages(history, false);
  }
}

// ─── Forward Message ────────────────────────────────────
function openForwardModal(msg, isGroup) {
  document.getElementById('forward-modal')?.remove();
  
  const modal = document.createElement('div');
  modal.id = 'forward-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <h3>Forward Message</h3>
      <div id="forward-friends-list" class="forward-friends-list"></div>
      <div class="modal-actions">
        <button class="modal-cancel" id="forward-close">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const list = document.getElementById('forward-friends-list');
  friends.forEach(friend => {
    const item = document.createElement('div');
    item.className = 'forward-friend-item';
    item.innerHTML = `
      <div class="friend-avatar-small" style="background:${friend.color}">
        ${friend.name.charAt(0).toUpperCase()}
      </div>
      <div class="friend-info-small">
        <div class="friend-name-small">${escHtml(friend.name)}</div>
        <div class="friend-status-small">${friend.status || 'Online'}</div>
      </div>
    `;
    item.addEventListener('click', async () => {
      await forwardMessage(msg, friend.id);
      modal.remove();
      showInAppNotif('Message Forwarded', `Sent to ${escHtml(friend.name)}`);
    });
    list.appendChild(item);
  });

  document.getElementById('forward-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

async function forwardMessage(msg, friendId) {
  try {
    // Forward text message only
    if (msg.text) {
      api.sendMessage(friendId, msg.text);
    }
  } catch (err) {
    showInAppNotif('Forward Failed', 'Unable to forward message.');
  }
}

// ─── Select Mode ─────────────────────────────────────────
function enterSelectMode(firstMsgId = null) {
  isSelectMode = true;
  selectedMessages.clear();
  if (firstMsgId) selectedMessages.add(firstMsgId);

  document.querySelectorAll('.msg-wrap').forEach(wrap => {
    wrap.classList.add('select-mode');
    const cb = wrap.querySelector('.msg-checkbox');
    if (cb && firstMsgId && wrap.dataset.msgId === firstMsgId) {
      cb.checked = true;
    }
  });

  document.getElementById('select-bar').classList.remove('hidden');
  updateSelectBar();
}

function exitSelectMode() {
  isSelectMode = false;
  selectedMessages.clear();
  document.querySelectorAll('.msg-wrap').forEach(wrap => wrap.classList.remove('select-mode'));
  document.querySelectorAll('.msg-checkbox').forEach(cb => cb.checked = false);
  document.getElementById('select-bar').classList.add('hidden');
}

function updateSelectBar() {
  const count = selectedMessages.size;
  document.getElementById('select-count').textContent = `${count} selected`;
  document.getElementById('select-delete-btn').disabled = count === 0;
}

async function deleteSelectedMessages() {
  if (selectedMessages.size === 0 || !activeConversation) return;
  const ids = Array.from(selectedMessages);
  const isGroup = activeConversation.type === 'group';
  if (!confirm(`Delete ${ids.length} message(s)?`)) return;

  if (isGroup) {
    await api.deleteGroupMessages(activeConversation.id, ids);
    const history = await api.getGroupChat(activeConversation.id);
    exitSelectMode();
    renderMessages(history, true);
  } else {
    await api.deleteMessages(activeConversation.id, ids);
    const history = await api.getChat(activeConversation.id);
    exitSelectMode();
    renderMessages(history, false);
  }
}

// ─── Download Chat History ─────────────────────────────
async function downloadChatHistory(friendId) {
  try {
    const friend = friends.find(f => f.id === friendId);
    if (!friend) return;
    
    const history = await api.getChat(friendId);
    if (!history || history.length === 0) {
      showInAppNotif('No Messages', 'There are no messages to download in this chat.');
      return;
    }

    // Format chat history as readable text
    const formatDate = (timestamp) => {
      const date = new Date(timestamp);
      return date.toLocaleString();
    };

    let chatText = `Chat History: You ↔ ${escHtml(friend.name)}\n`;
    chatText += `Exported on: ${formatDate(Date.now())}\n`;
    chatText += `Total messages: ${history.length}\n`;
    chatText += `\n${'─'.repeat(60)}\n\n`;

    history.forEach(msg => {
      const sender = msg.from === 'me' ? myConfig.name : friend.name;
      const time = formatDate(msg.time);
      
      if (msg.type === 'file') {
        chatText += `[${time}] ${sender}:\n📎 ${escHtml(msg.fileName)} (${formatSize(msg.fileSize)})\n\n`;
      } else {
        chatText += `[${time}] ${sender}:\n${escHtml(msg.text || '')}\n\n`;
      }
    });

    // Create a Blob and trigger download
    const blob = new Blob([chatText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Chat_${escHtml(friend.name)}_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showInAppNotif('Chat Downloaded', `Chat history with ${escHtml(friend.name)} has been downloaded.`);
  } catch (err) {
    showInAppNotif('Download Failed', 'Unable to download chat history.');
  }
}

// ─── Reactions ───────────────────────────────────────────
function sendReaction(msg, isGroup, emoji) {
  if (!activeConversation) return;
  if (isGroup) {
    const wrap = document.querySelector(`[data-msg-id="${msg.id}"]`);
    if (wrap) updateReactionDisplay(wrap, emoji);
  } else {
    api.sendReaction(activeConversation.id, msg.id, emoji);
  }
}

function updateReactionDisplay(wrap, emoji) {
  const bubble = wrap.querySelector('.msg-bubble');
  let reactEl = bubble.querySelector('.msg-reactions');
  if (!reactEl) {
    reactEl = document.createElement('div');
    reactEl.className = 'msg-reactions';
    bubble.appendChild(reactEl);
  }
  let chip = Array.from(reactEl.querySelectorAll('.reaction-chip')).find(c => c.textContent.trim().startsWith(emoji));
  if (chip) {
    const count = (parseInt(chip.dataset.count) || 1) + 1;
    chip.dataset.count = count;
    chip.textContent = emoji + ' ' + count;
  } else {
    const span = document.createElement('span');
    span.className = 'reaction-chip';
    span.textContent = emoji;
    span.dataset.count = 1;
    reactEl.appendChild(span);
  }
}

function setReply(msg) {
  replyToMsg = msg;
  document.getElementById('reply-text').textContent = '↩ ' + (msg.text || msg.fileName || '').substring(0, 80);
  document.getElementById('reply-preview').classList.remove('hidden');
  document.getElementById('msg-input').focus();
}

// ─── Send Message ────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !activeConversation) return;

  const replyTo = replyToMsg ? { id: replyToMsg.id, text: replyToMsg.text } : null;

  if (activeConversation.type === 'friend') {
    api.sendMessage(activeConversation.id, text, replyTo);
    lastMessages[activeConversation.id] = { text, time: Date.now(), from: 'me' };
  } else {
    api.sendGroupMessage(activeConversation.id, text, replyTo);
  }

  input.value = '';
  replyToMsg = null;
  document.getElementById('reply-preview').classList.add('hidden');
  clearTimeout(typingTimer);
  if (activeConversation.type === 'friend') api.typingStop(activeConversation.id);
}

// ─── Drag & Drop File Staging ────────────────────────────
function setupDragDrop() {
  const wrap = document.getElementById('messages-wrap');
  if (!wrap) return;

  wrap.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only activate for friend chats (files are 1-to-1 only)
    if (!activeConversation || activeConversation.type !== 'friend') return;
    // Check if this is a file drag (not text selection)
    if (!e.dataTransfer.types || !e.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    if (dragDepth === 1) showDropOverlay();
  });

  wrap.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; hideDropOverlay(); }
  });

  wrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show drop effect if files are being dragged
    if (e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    hideDropOverlay();
    if (!activeConversation || activeConversation.type !== 'friend') return;
    // Only handle drop if files are present
    if (e.dataTransfer.types && !e.dataTransfer.types.includes('Files')) return;
    handleDroppedItems(e.dataTransfer.items || [], e.dataTransfer.files);
  });
}

function showDropOverlay() {
  let overlay = document.getElementById('drop-overlay');
  if (overlay) { overlay.classList.remove('hidden'); return; }

  overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.className = 'drop-overlay';
  overlay.innerHTML = `
    <div class="drop-overlay-inner">
      <div class="drop-icon">📂</div>
      <div class="drop-title">Drop files or folders here</div>
      <div class="drop-sub">They'll be staged before sending</div>
    </div>
  `;
  document.getElementById('messages-wrap').appendChild(overlay);
}

function hideDropOverlay() {
  const overlay = document.getElementById('drop-overlay');
  if (overlay) overlay.classList.add('hidden');
}

async function handleDroppedItems(dataTransferItems, fallbackFiles) {
  const collected = [];

  // Use DataTransferItemList (supports folders via webkitGetAsEntry)
  if (dataTransferItems && dataTransferItems.length > 0) {
    const entries = [];
    for (const item of dataTransferItems) {
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
        else {
          const f = item.getAsFile();
          if (f) collected.push({ name: f.name, size: f.size, isDir: false, nativeFile: f, path: f.path || '' });
        }
      }
    }
    // Recursively read entries
    for (const entry of entries) {
      await collectEntry(entry, collected);
    }
  } else if (fallbackFiles) {
    // Fallback: plain FileList
    for (const f of fallbackFiles) {
      collected.push({ name: f.name, size: f.size, isDir: false, nativeFile: f, path: f.path || '' });
    }
  }

  if (collected.length === 0) return;

  // In Electron, files dropped from the OS have a .path property (native FS path)
  // Build staged list with image preview where applicable
  for (const item of collected) {
    const prev = await buildPreview(item);
    stagedFiles.push({ ...item, previewUrl: prev });
  }

  renderStagingBar();
}

async function collectEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ name: file.name, size: file.size, isDir: false, nativeFile: file, path: file.path || entry.fullPath || '' });
  } else if (entry.isDirectory) {
    // Mark folder itself
    out.push({ name: entry.name, size: 0, isDir: true, path: entry.fullPath || entry.name });
    // Recurse children
    const reader = entry.createReader();
    const readAll = () => new Promise((res) => {
      const all = [];
      const read = () => reader.readEntries(async (entries) => {
        if (!entries.length) { res(all); return; }
        all.push(...entries);
        read();
      }, () => res(all));
      read();
    });
    const children = await readAll();
    for (const child of children) {
      await collectEntry(child, out);
    }
  }
}

function buildPreview(item) {
  return new Promise((resolve) => {
    if (item.isDir || !item.nativeFile) { resolve(null); return; }
    const ext = item.name.split('.').pop().toLowerCase();
    if (!['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext)) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(item.nativeFile);
  });
}

function renderStagingBar() {
  // Remove old staging bar
  document.getElementById('staging-bar')?.remove();

  if (stagedFiles.length === 0) return;

  const bar = document.createElement('div');
  bar.id = 'staging-bar';
  bar.className = 'staging-bar';

  // Header row
  const header = document.createElement('div');
  header.className = 'staging-header';
  header.innerHTML = `
    <span class="staging-label">📎 ${stagedFiles.length} item${stagedFiles.length > 1 ? 's' : ''} ready to send</span>
    <button class="staging-clear-all" id="staging-clear-all" title="Remove all">✕ Clear all</button>
  `;
  bar.appendChild(header);

  // File chips row
  const chips = document.createElement('div');
  chips.className = 'staging-chips';

  stagedFiles.forEach((item, idx) => {
    const chip = document.createElement('div');
    chip.className = 'staging-chip';
    chip.dataset.idx = idx;

    if (item.previewUrl) {
      chip.innerHTML = `
        <img src="${item.previewUrl}" class="staging-thumb" alt="${escHtml(item.name)}">
        <div class="staging-chip-info">
          <div class="staging-chip-name">${escHtml(truncateName(item.name, 18))}</div>
          <div class="staging-chip-size">${item.isDir ? 'Folder' : formatSize(item.size)}</div>
        </div>
        <button class="staging-remove" data-idx="${idx}" title="Remove">✕</button>
      `;
    } else {
      const icon = item.isDir ? '📁' : getFileIcon(item.name.split('.').pop().toLowerCase());
      chip.innerHTML = `
        <div class="staging-chip-icon">${icon}</div>
        <div class="staging-chip-info">
          <div class="staging-chip-name">${escHtml(truncateName(item.name, 22))}</div>
          <div class="staging-chip-size">${item.isDir ? 'Folder' : formatSize(item.size)}</div>
        </div>
        <button class="staging-remove" data-idx="${idx}" title="Remove">✕</button>
      `;
    }

    chips.appendChild(chip);
  });

  bar.appendChild(chips);

  // Action row: optional message label and send button
  const actions = document.createElement('div');
  actions.className = 'staging-actions';
  actions.innerHTML = `
    <span class="staging-hint">Add a message below (optional), then send</span>
    <button class="staging-send-btn" id="staging-send-btn">
      Send ${stagedFiles.length} file${stagedFiles.length > 1 ? 's' : ''}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>
    </button>
  `;
  bar.appendChild(actions);

  // Insert above reply-preview / input-bar
  const chatView = document.getElementById('chat-view');
  const inputBar = chatView.querySelector('.input-bar');
  chatView.insertBefore(bar, inputBar);

  // Events
  document.getElementById('staging-clear-all').addEventListener('click', clearStagedFiles);

  bar.querySelectorAll('.staging-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.idx);
      stagedFiles.splice(i, 1);
      renderStagingBar();
    });
  });

  document.getElementById('staging-send-btn').addEventListener('click', sendStagedFiles);

  // Focus input for optional message
  document.getElementById('msg-input').focus();
}

async function sendStagedFiles() {
  if (!activeConversation || activeConversation.type !== 'friend') return;
  if (stagedFiles.length === 0) return;

  const friendId = activeConversation.id;
  const msgText = document.getElementById('msg-input').value.trim();

  // Send optional text message first
  if (msgText) {
    api.sendMessage(friendId, msgText, null);
    lastMessages[friendId] = { text: msgText, time: Date.now(), from: 'me' };
    document.getElementById('msg-input').value = '';
    renderChatList();
  }

  // Send each staged file via the existing api.sendFile IPC
  for (const item of stagedFiles) {
    const filePath = item.path || item.nativeFile?.path;
    if (!filePath) continue;

    try {
      await api.sendFile(friendId, filePath);
    } catch (e) {
      // Error handled
    }
  }

  clearStagedFiles();
}

function clearStagedFiles() {
  stagedFiles = [];
  document.getElementById('staging-bar')?.remove();
}

function truncateName(name, max) {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  const base = name.slice(0, max - ext.length - 1);
  return base + '…' + ext;
}

// ─── WebRTC ──────────────────────────────────────────────
async function createPeerConnection(friendId) {
  if (peerConnection) {
    try { peerConnection.close(); } catch(e) {}
    peerConnection = null;
  }

  pendingIceCandidates = [];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      api.sendWebRTCIce(friendId, e.candidate);
    }
  };

  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) {
      const remoteVideo = document.getElementById('remote-video');
      // Avoid re-assigning same stream (prevents flicker)
      if (remoteVideo.srcObject !== e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
      }
      remoteVideo.play().catch(() => {});
      document.getElementById('call-status').textContent = 'Connected';

      if (currentCallType === 'audio') {
        const friend = friends.find(f => f.id === friendId);
        const audioAv = document.getElementById('call-audio-avatar');
        audioAv.innerHTML = '';
        renderAvatarEl(audioAv, friend?.name || friendId, friend?.color, friend?.avatar, 120);
        audioAv.classList.remove('hidden');
      }
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    const statusEl = document.getElementById('call-status');
    if (statusEl) {
      if (state === 'connected') statusEl.textContent = 'Connected';
      else if (state === 'connecting') statusEl.textContent = 'Connecting...';
      else if (state === 'failed') statusEl.textContent = 'Connection Failed';
      else if (state === 'disconnected') statusEl.textContent = 'Reconnecting...';
    }
    if (state === 'failed') {
      showInAppNotif('Call Failed', 'Could not establish connection. Check LAN connectivity.');
      endCall();
    }
  };

  pc.onnegotiationneeded = () => {};

  return pc;
}

async function startCall(friendId, callType = 'video') {
  if (!supportsWebRTC()) {
    showInAppNotif('WebRTC Unsupported', 'Audio and video calls are not available in this environment.');
    callFriendId = null;
    currentCallType = null;
    return;
  }

  if (peerConnection) {
    showInAppNotif('Already in a Call', 'End the current call before starting a new one.');
    return;
  }

  if (!nearbyPeers.has(friendId)) {
    showInAppNotif('Peer Offline', 'This person is not currently online.');
    return;
  }

  callFriendId = friendId;
  currentCallType = callType;

  try {
    if (callType === 'video') {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } else if (callType === 'audio') {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    } else if (callType === 'screen') {
      await startScreenShareCall(friendId);
      return;
    }
  } catch (e) {
    const msg = getMediaErrorMessage(e, 'Could not start call.');
    showInAppNotif('Media Error', msg);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      showPermissionModal(callType);
    }
    callFriendId = null;
    currentCallType = null;
    return;
  }

  const localVideo = document.getElementById('local-video');
  if (callType === 'video') {
    localVideo.srcObject = localStream;
    localVideo.style.display = 'block';
    // Mirror local preview naturally (like a selfie camera)
    localVideo.style.transform = 'scaleX(-1)';
    localVideo.play().catch(() => {});
  } else {
    localVideo.style.display = 'none';
    localVideo.style.transform = '';
    const audioAv = document.getElementById('call-audio-avatar');
    const friend = friends.find(f => f.id === friendId);
    audioAv.innerHTML = '';
    renderAvatarEl(audioAv, friend?.name || friendId, friend?.color, friend?.avatar, 120);
    audioAv.classList.remove('hidden');
  }

  // Remote video should NOT be mirrored
  document.getElementById('remote-video').style.transform = 'none';

  peerConnection = await createPeerConnection(friendId);

  // Add all tracks explicitly
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  try {
    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: callType !== 'audio'
    });
    await peerConnection.setLocalDescription(offer);

    api.sendWebRTCOffer(friendId, { type: offer.type, sdp: offer.sdp }, callType);

    const friend = friends.find(f => f.id === friendId);
    document.getElementById('call-peer-name').textContent = friend?.name || friendId;
    document.getElementById('call-status').textContent = callType === 'audio' ? 'Calling (Audio)...' : 'Calling...';
    updateCallUI(callType);
    document.getElementById('video-call-overlay').classList.remove('hidden');
    renderChatList(); // Show calling animation in sidebar
  } catch (e) {
    const msg = getMediaErrorMessage(e, 'Failed to create offer.');
    showInAppNotif('Call Error', msg);
    endCall();
  }
}

async function startScreenShareCall(friendId) {
  if (!supportsWebRTC()) {
    showInAppNotif('WebRTC Unsupported', 'Screen sharing is not available in this environment.');
    callFriendId = null;
    currentCallType = null;
    return;
  }

  if (typeof api.getScreenSources !== 'function') {
    showInAppNotif('Screen Share Unsupported', 'Screen sharing is not available on this platform.');
    callFriendId = null;
    currentCallType = null;
    return;
  }

  try {
    const sources = await api.getScreenSources();
    if (!sources || sources.length === 0) {
      showInAppNotif('Screen Share Unavailable', 'No screens or windows could be found to share.');
      callFriendId = null;
      currentCallType = null;
      return;
    }
    const chosen = await showScreenPickerModal(sources);
    if (!chosen) {
      callFriendId = null;
      currentCallType = null;
      return;
    }

    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: chosen,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30
        }
      }
    });

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch(e) {
      localStream = null;
    }

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = screenStream;
    localVideo.style.display = 'block';
    localVideo.style.transform = 'none'; // No mirror for screen share
    localVideo.play().catch(() => {});

    document.getElementById('remote-video').style.transform = 'none';

    peerConnection = await createPeerConnection(friendId);

    screenStream.getTracks().forEach(t => peerConnection.addTrack(t, screenStream));
    if (localStream) {
      localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    }

    const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await peerConnection.setLocalDescription(offer);

    api.sendWebRTCOffer(friendId, { type: offer.type, sdp: offer.sdp }, 'screen');

    const friend = friends.find(f => f.id === friendId);
    document.getElementById('call-peer-name').textContent = friend?.name || friendId;
    document.getElementById('call-status').textContent = 'Screen Sharing...';
    isScreenSharing = true;
    currentCallType = 'screen';
    updateCallUI('screen');
    document.getElementById('video-call-overlay').classList.remove('hidden');
    initAnnotationLayers();
    renderChatList();

    screenStream.getVideoTracks()[0].onended = () => endCall();

  } catch (e) {
    const msg = getMediaErrorMessage(e, 'Could not start screen share.');
    showInAppNotif('Screen Share Error', msg);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      showPermissionModal('screen');
    }
    callFriendId = null;
    currentCallType = null;
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  }
}

function showScreenPickerModal(sources) {
  return new Promise((resolve) => {
    document.getElementById('screen-picker-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'screen-picker-modal';
    modal.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box screen-picker-box';
    box.innerHTML = `<h3>Choose Screen to Share</h3><div class="screen-source-grid" id="screen-source-grid"></div>
      <div class="modal-actions" style="margin-top:12px">
        <button class="modal-cancel" id="screen-pick-cancel">Cancel</button>
      </div>`;
    modal.appendChild(box);
    document.body.appendChild(modal);

    const grid = document.getElementById('screen-source-grid');
    sources.forEach(src => {
      const item = document.createElement('div');
      item.className = 'screen-source-item';
      item.innerHTML = `<img src="${src.thumbnail}" alt="${escHtml(src.name)}">
        <div class="screen-source-name">${escHtml(src.name)}</div>`;
      item.addEventListener('click', () => {
        modal.remove();
        resolve(src.id);
      });
      grid.appendChild(item);
    });

    document.getElementById('screen-pick-cancel').addEventListener('click', () => {
      modal.remove();
      resolve(null);
    });
  });
}

async function acceptIncomingCall() {
  document.getElementById('incoming-call').classList.add('hidden');
  if (!callIncoming) return;

  if (!supportsWebRTC()) {
    showInAppNotif('WebRTC Unsupported', 'Audio and video calls are not available in this environment.');
    api.endWebRTC(callIncoming.fromId);
    callIncoming = null;
    return;
  }

  if (peerConnection) {
    showInAppNotif('Already in a Call', 'End your current call first.');
    api.endWebRTC(callIncoming.fromId);
    callIncoming = null;
    return;
  }

  callFriendId = callIncoming.fromId;
  currentCallType = callIncoming.callType || 'video';
  const incomingOffer = callIncoming.offer;
  callIncoming = null;

  if (!incomingOffer || !incomingOffer.type || !incomingOffer.sdp) {
    showInAppNotif('Call Error', 'Received invalid call offer.');
    callFriendId = null;
    return;
  }

  try {
    if (currentCallType === 'screen') {
      localStream = null;
      try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch(e) {}
    } else if (currentCallType === 'audio') {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    } else {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
  } catch (e) {
    const msg = getMediaErrorMessage(e, 'Could not start call.');
    showInAppNotif('Media Error', msg);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      showPermissionModal(currentCallType);
    }
    if (callFriendId) api.endWebRTC(callFriendId);
    callFriendId = null;
    return;
  }

  const localVideo = document.getElementById('local-video');
  if (currentCallType === 'video' && localStream) {
    localVideo.srcObject = localStream;
    localVideo.style.display = 'block';
    localVideo.style.transform = 'scaleX(-1)'; // Mirror local preview
    localVideo.play().catch(() => {});
  } else {
    localVideo.style.display = 'none';
    localVideo.style.transform = '';
  }

  // Remote video: no mirror
  document.getElementById('remote-video').style.transform = 'none';

  if (currentCallType === 'audio') {
    const friend = friends.find(f => f.id === callFriendId);
    const audioAv = document.getElementById('call-audio-avatar');
    audioAv.innerHTML = '';
    renderAvatarEl(audioAv, friend?.name || callFriendId, friend?.color, friend?.avatar, 120);
    audioAv.classList.remove('hidden');
  }

  peerConnection = await createPeerConnection(callFriendId);

  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  try {
    const remoteDesc = new RTCSessionDescription({ type: incomingOffer.type, sdp: incomingOffer.sdp });
    await peerConnection.setRemoteDescription(remoteDesc);

    // Drain queued ICE candidates
    for (const candidate of pendingIceCandidates) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    }
    pendingIceCandidates = [];

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    api.sendWebRTCAnswer(callFriendId, { type: answer.type, sdp: answer.sdp });

    const friend = friends.find(f => f.id === callFriendId);
    document.getElementById('call-peer-name').textContent = friend?.name || callFriendId;
    document.getElementById('call-status').textContent = 'Connecting...';
    updateCallUI(currentCallType);
    document.getElementById('video-call-overlay').classList.remove('hidden');
    renderChatList();

    if (currentCallType === 'screen') {
      initAnnotationLayers();
    }
  } catch (e) {
    showInAppNotif('Call Error', 'Failed to connect: ' + e.message);
    endCall();
  }
}

function rejectIncomingCall() {
  document.getElementById('incoming-call').classList.add('hidden');
  if (callIncoming) {
    api.endWebRTC(callIncoming.fromId);
    callIncoming = null;
  }
}

function endCall() {
  stopCaptions();
  cleanupAnnotationLayers();

  if (callFriendId) {
    try { api.endWebRTC(callFriendId); } catch(e) {}
  }

  if (peerConnection) {
    try { peerConnection.close(); } catch(e) {}
    peerConnection = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(t => { try { t.stop(); } catch(e) {} });
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => { try { t.stop(); } catch(e) {} });
    screenStream = null;
  }

  const rv = document.getElementById('remote-video');
  const lv = document.getElementById('local-video');
  if (rv) { rv.srcObject = null; rv.style.transform = 'none'; }
  if (lv) { lv.srcObject = null; lv.style.display = 'block'; lv.style.transform = ''; }

  const audioAv = document.getElementById('call-audio-avatar');
  if (audioAv) audioAv.classList.add('hidden');

  document.getElementById('video-call-overlay').classList.add('hidden');

  const prevFriend = callFriendId;
  callFriendId = null;
  callIncoming = null;
  currentCallType = null;
  isScreenSharing = false;
  isMuted = false;
  isCamOff = false;
  pendingIceCandidates = [];
  annotationEnabled = false;

  document.getElementById('call-mute-btn').textContent = '🎙️';
  document.getElementById('call-cam-btn').textContent = '📷';

  if (prevFriend) renderChatList(); // Remove calling animation from sidebar
}

function updateCallUI(callType) {
  const camBtn = document.getElementById('call-cam-btn');
  const shareBtn = document.getElementById('call-share-btn');
  const annotatePanel = document.getElementById('annotation-panel');
  const captionBtn = document.getElementById('call-caption-btn');

  camBtn.style.display = 'flex';
  shareBtn.style.display = 'flex';
  captionBtn.style.display = 'flex';
  annotatePanel.classList.add('hidden');

  if (callType === 'audio') {
    camBtn.style.display = 'none';
    shareBtn.style.display = 'none';
  } else if (callType === 'screen') {
    camBtn.style.display = 'none';
    shareBtn.style.display = 'none';
    annotatePanel.classList.remove('hidden');
  }
}

function toggleMute() {
  const stream = localStream || screenStream;
  if (!stream) return;
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    isMuted = !isMuted;
    audioTrack.enabled = !isMuted;
    document.getElementById('call-mute-btn').textContent = isMuted ? '🔇' : '🎙️';
    document.getElementById('call-mute-btn').title = isMuted ? 'Unmute' : 'Mute';
  }
}

function toggleCam() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    isCamOff = !isCamOff;
    videoTrack.enabled = !isCamOff;
    document.getElementById('call-cam-btn').textContent = isCamOff ? '🚫' : '📷';
  }
}

// ─── Annotation: Per-User Layer System ──────────────────
// Each user (local + remote) gets their own <canvas> inside the video wrap.
// The local user's canvas is interactive; remote canvas is drawn on from received events.
// No events are re-broadcast from received draws — only locally-initiated draws send events.

function initAnnotationLayers() {
  cleanupAnnotationLayers();

  const overlay = document.getElementById('video-call-overlay');
  const remoteWrap = overlay.querySelector('.call-remote-video-wrap');
  annotationContainer = remoteWrap;

  // Create layer for the local user
  createAnnotationLayer(myConfig.id || 'me', myConfig.name || 'Me', myConfig.color || '#ff3b3b', true);
}

function createAnnotationLayer(userId, userName, userColor, isLocal) {
  if (annotationLayers.has(userId)) return annotationLayers.get(userId);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    'width:100%',
    'height:100%',
    'z-index:10',
    'pointer-events:none',
  ].join(';');
  canvas.dataset.userId = userId;

  // Name label for this user's layer
  const label = document.createElement('div');
  label.style.cssText = [
    'position:absolute',
    'top:8px',
    isLocal ? 'right:8px' : 'left:8px',
    'background:' + (userColor || '#ff3b3b'),
    'color:#fff',
    'font-size:11px',
    'font-weight:600',
    'padding:2px 8px',
    'border-radius:10px',
    'z-index:11',
    'pointer-events:none',
    'opacity:0',
    'transition:opacity 0.3s',
  ].join(';');
  label.textContent = '✏️ ' + (userName || userId);
  label.dataset.userId = userId;
  label.dataset.labelEl = '1';

  if (annotationContainer) {
    annotationContainer.appendChild(canvas);
    annotationContainer.appendChild(label);
  }

  function resize() {
    if (!annotationContainer) return;
    canvas.width = annotationContainer.clientWidth;
    canvas.height = annotationContainer.clientHeight;
  }
  resize();
  window._annotResizeHandlers = window._annotResizeHandlers || [];
  window._annotResizeHandlers.push(resize);
  window.addEventListener('resize', resize);

  const ctx = canvas.getContext('2d');
  const layer = { canvas, ctx, label, lastX: null, lastY: null, isLocal, fadeTimer: null };
  annotationLayers.set(userId, layer);

  if (isLocal) {
    // Attach draw events only to the local layer's canvas
    canvas.addEventListener('mousedown', onLocalDrawStart);
    canvas.addEventListener('mousemove', onLocalDraw);
    canvas.addEventListener('mouseup', onLocalDrawStop);
    canvas.addEventListener('mouseleave', onLocalDrawStop);
  }

  return layer;
}

function showLayerLabel(userId) {
  const layer = annotationLayers.get(userId);
  if (!layer) return;
  layer.label.style.opacity = '1';
  clearTimeout(layer.fadeTimer);
  layer.fadeTimer = setTimeout(() => {
    layer.label.style.opacity = '0';
  }, 1500);
}

function cleanupAnnotationLayers() {
  // Remove all canvases and labels
  annotationLayers.forEach(({ canvas, label }) => {
    canvas.removeEventListener('mousedown', onLocalDrawStart);
    canvas.removeEventListener('mousemove', onLocalDraw);
    canvas.removeEventListener('mouseup', onLocalDrawStop);
    canvas.removeEventListener('mouseleave', onLocalDrawStop);
    canvas.remove();
    label.remove();
  });
  annotationLayers.clear();

  // Remove old resize handlers
  if (window._annotResizeHandlers) {
    window._annotResizeHandlers.forEach(fn => window.removeEventListener('resize', fn));
    window._annotResizeHandlers = [];
  }
  annotationContainer = null;
  isDrawing = false;
  annotationEnabled = false;
}

function enableAnnotation(enabled) {
  annotationEnabled = enabled;
  const myLayer = annotationLayers.get(myConfig.id || 'me');
  if (!myLayer) return;
  myLayer.canvas.style.pointerEvents = enabled ? 'auto' : 'none';
  myLayer.canvas.style.cursor = enabled ? 'crosshair' : 'default';
}

function onLocalDrawStart(e) {
  if (!annotationEnabled) return;
  isDrawing = true;
  const myId = myConfig.id || 'me';
  const layer = annotationLayers.get(myId);
  if (!layer) return;
  const r = layer.canvas.getBoundingClientRect();
  layer.lastX = e.clientX - r.left;
  layer.lastY = e.clientY - r.top;
  layer.ctx.beginPath();
  layer.ctx.moveTo(layer.lastX, layer.lastY);
  showLayerLabel(myId);
}

function onLocalDraw(e) {
  if (!isDrawing || !annotationEnabled) return;
  const myId = myConfig.id || 'me';
  const layer = annotationLayers.get(myId);
  if (!layer) return;

  const r = layer.canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;

  layer.ctx.lineWidth = drawSize;
  layer.ctx.lineCap = 'round';
  layer.ctx.lineJoin = 'round';
  layer.ctx.strokeStyle = drawColor;
  layer.ctx.lineTo(x, y);
  layer.ctx.stroke();
  layer.ctx.beginPath();
  layer.ctx.moveTo(x, y);
  layer.lastX = x;
  layer.lastY = y;

  showLayerLabel(myId);

  // Send normalized coordinates to peer — do NOT rebroadcast received events
  if (callFriendId) {
    const nx = x / layer.canvas.width;
    const ny = y / layer.canvas.height;
    api.sendAnnotation(callFriendId, {
      type: 'draw',
      x: nx, y: ny,
      color: drawColor,
      size: drawSize,
      userId: myId,
      userName: myConfig.name || 'Me'
    });
  }
}

function onLocalDrawStop() {
  isDrawing = false;
  const myId = myConfig.id || 'me';
  const layer = annotationLayers.get(myId);
  if (layer) {
    layer.ctx.beginPath();
    layer.lastX = null;
    layer.lastY = null;
  }
}

function clearAnnotation() {
  // Clear all layers
  annotationLayers.forEach(({ canvas, ctx }) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
  if (callFriendId) {
    api.sendAnnotation(callFriendId, { type: 'clear', userId: myConfig.id || 'me' });
  }
}

function receiveAnnotation(data, fromId) {
  // This is a RECEIVED event from a remote user — draw on their layer only, do NOT re-send
  if (data.type === 'clear') {
    if (data.userId) {
      // Clear only that user's layer
      const layer = annotationLayers.get(data.userId);
      if (layer) layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    } else {
      // Clear all remote layers
      annotationLayers.forEach((layer, userId) => {
        if (userId !== (myConfig.id || 'me')) {
          layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        }
      });
    }
    return;
  }

  if (data.type === 'draw') {
    const userId = data.userId || fromId || 'remote';
    const userName = data.userName || (friends.find(f => f.id === userId)?.name) || 'Remote';
    const userColor = data.color || '#3b82f6';

    // Get or create a layer for this remote user
    let layer = annotationLayers.get(userId);
    if (!layer) {
      layer = createAnnotationLayer(userId, userName, userColor, false);
    }

    const x = data.x * layer.canvas.width;
    const y = data.y * layer.canvas.height;

    layer.ctx.lineWidth = data.size || 3;
    layer.ctx.lineCap = 'round';
    layer.ctx.lineJoin = 'round';
    layer.ctx.strokeStyle = data.color || '#3b82f6';

    if (layer.lastX === null || layer.lastY === null) {
      layer.ctx.beginPath();
      layer.ctx.moveTo(x, y);
    } else {
      layer.ctx.lineTo(x, y);
      layer.ctx.stroke();
      layer.ctx.beginPath();
      layer.ctx.moveTo(x, y);
    }
    layer.lastX = x;
    layer.lastY = y;

    showLayerLabel(userId);
  }
}

// ─── Captions ─────────────────────────────────────────
function toggleCaptions() {
  if (!captionActive) {
    startCaptions();
  } else {
    stopCaptions();
  }
}

function startCaptions() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showInAppNotif('Captions', 'Speech recognition not supported in this browser.');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    const text = result[0].transcript;
    showCaption(text, 'me', result.isFinal);
    if (result.isFinal && callFriendId) {
      api.sendCaption(callFriendId, text);
    }
  };

  recognition.onerror = (e) => {
    // Error handled silently
  };

  recognition.onend = () => {
    if (captionActive) recognition.start();
  };

  recognition.start();
  captionActive = true;
  document.getElementById('call-caption-btn').style.opacity = '1';
  document.getElementById('call-caption-btn').style.background = 'var(--accent)';
  document.getElementById('caption-display').classList.remove('hidden');
}

function stopCaptions() {
  if (recognition) {
    captionActive = false;
    try { recognition.stop(); } catch(e) {}
    recognition = null;
  }
  captionActive = false;
  const btn = document.getElementById('call-caption-btn');
  if (btn) { btn.style.opacity = '0.6'; btn.style.background = ''; }
  document.getElementById('caption-display')?.classList.add('hidden');
}

let captionClearTimer = null;
function showCaption(text, who, isFinal) {
  const el = document.getElementById('caption-display');
  if (!el) return;
  el.classList.remove('hidden');
  const label = who === 'me' ? (myConfig.name || 'Me') : (friends.find(f => f.id === callFriendId)?.name || 'Peer');
  el.innerHTML = `<span class="caption-speaker">${escHtml(label)}:</span> ${escHtml(text)}`;
  if (isFinal) {
    clearTimeout(captionClearTimer);
    captionClearTimer = setTimeout(() => { el.innerHTML = ''; }, 4000);
  }
}

// ─── In-App Notification ─────────────────────────────────
let notifQueue = [];
let notifShowing = false;

function showInAppNotif(title, body) {
  notifQueue.push({ title, body });
  if (!notifShowing) processNotifQueue();
}

function processNotifQueue() {
  if (notifQueue.length === 0) { notifShowing = false; return; }
  notifShowing = true;
  const { title, body } = notifQueue.shift();

  const el = document.getElementById('in-app-notif');
  el.querySelector('.notif-title').textContent = title;
  el.querySelector('.notif-body').textContent = body;
  el.classList.remove('hidden');
  el.classList.add('show');

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.classList.add('hidden');
      notifShowing = false;
      if (notifQueue.length > 0) setTimeout(processNotifQueue, 200);
    }, 400);
  }, 3500);
}

document.getElementById('in-app-notif').querySelector('.notif-close').addEventListener('click', () => {
  const el = document.getElementById('in-app-notif');
  el.classList.remove('show');
  notifShowing = false;
  setTimeout(() => {
    el.classList.add('hidden');
    if (notifQueue.length > 0) setTimeout(processNotifQueue, 200);
  }, 400);
});

// ─── IPC Listeners ──────────────────────────────────────
function setupIPCListeners() {
  api.on('ask-name', () => showSetupModal());

  api.on('peer-discovered', (peer) => {
    if (peer.offline) {
      nearbyPeers.delete(peer.id);
    } else {
      nearbyPeers.set(peer.id, peer);
    }
    renderChatList();
    renderNearby();
    if (activeConversation?.type === 'friend' && activeConversation?.id === peer.id) {
      document.getElementById('topbar-status').textContent = peer.offline ? 'Offline' : (peer.status || 'Online');
    }
  });

  api.on('friends-updated', async () => {
    friends = await api.getFriends();
    await preloadLastMessages();
    renderChatList();
    renderRequests();
    renderNearby();
  });

  api.on('groups-updated', async () => {
    groups = await api.getGroups();
    renderGroupList();
  });

  api.on('group-created', (group) => {
    groups = [...groups.filter(g => g.id !== group.id), group];
    renderGroupList();
    openGroupChat(group.id);
  });

  api.on('chat-message', (msg) => {
    const isActiveChat = activeConversation?.type === 'friend' && activeConversation?.id === msg.friendId;

    lastMessages[msg.friendId] = {
      text: msg.type === 'file' ? `📎 ${msg.fileName}` : (msg.text || ''),
      time: msg.time,
      from: msg.from
    };

    if (isActiveChat) {
      appendMessage(msg, false);
      scrollToBottom();
      api.markRead(msg.friendId);
    } else {
      if (msg.from !== 'me') {
        unreadCounts[msg.friendId] = (unreadCounts[msg.friendId] || 0) + 1;
      }
    }
    renderChatList();
  });

  api.on('group-message', (msg) => {
    const isActiveGroup = activeConversation?.type === 'group' && activeConversation?.id === msg.groupId;
    if (isActiveGroup) {
      appendMessage(msg, true);
      scrollToBottom();
    }
    renderGroupList();
  });

  api.on('peer-typing', ({ friendId, typing }) => {
    if (activeConversation?.type === 'friend' && activeConversation?.id === friendId) {
      const indicator = document.getElementById('typing-indicator');
      indicator.classList.toggle('hidden', !typing);
      if (typing) scrollToBottom();
    }
  });

  api.on('message-reaction', ({ friendId, messageId, emoji }) => {
    const wrap = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (wrap) updateReactionDisplay(wrap, emoji);
  });

  api.on('message-status', ({ friendId, msgId, status }) => {
    const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (wrap) {
      const statusEl = wrap.querySelector('.msg-status');
      if (statusEl) {
        statusEl.textContent = status === 'queued' ? '⏳' : status === 'read' ? '✓✓' : '✓';
        statusEl.title = status === 'queued' ? 'Will send when online' : status;
      }
    }
  });

  api.on('offline-queue-flushed', ({ friendId }) => {
    if (activeConversation?.type === 'friend' && activeConversation?.id === friendId) {
      api.getChat(friendId).then(history => renderMessages(history, false));
    }
    showInAppNotif('Messages Delivered', 'Queued messages have been delivered.');
  });

  api.on('file-progress', ({ friendId, msgId, progress }) => {
    updateFileProgress(msgId, progress, friendId);
  });

  api.on('file-sent', ({ friendId, msgId }) => {
    updateFileProgress(msgId, 100, friendId);
  });

  api.on('file-incoming', ({ fromId, fromName, fileName, fileSize, transferId }) => {
    const isActiveChat = activeConversation?.type === 'friend' && activeConversation?.id === fromId;
    if (isActiveChat) {
      const msg = { id: transferId, from: fromId, type: 'file', fileName, fileSize, time: Date.now(), status: 'receiving' };
      appendMessage(msg, false);
      scrollToBottom();
    }
  });

  api.on('file-complete', ({ friendId, id, fileName, fileSize, status }) => {
    const isActiveChat = activeConversation?.type === 'friend' && activeConversation?.id === friendId;

    lastMessages[friendId] = { text: `📎 ${fileName}`, time: Date.now(), from: friendId };

    const wrap = document.querySelector(`[data-msg-id="${id}"]`);
    if (wrap) {
      const bar = wrap.querySelector('.file-progress-bar');
      const label = wrap.querySelector('.file-status-label');
      const btns = wrap.querySelectorAll('.file-btn');
      const fill = wrap.querySelector('.file-progress-fill');
      if (fill) fill.style.width = '100%';
      setTimeout(() => {
        if (bar) bar.style.display = 'none';
        if (label) label.remove();
        btns.forEach(b => b.disabled = false);
      }, 600);
    } else if (isActiveChat) {
      const msg = { id, from: friendId, type: 'file', fileName, fileSize, time: Date.now(), status: 'received' };
      appendMessage(msg, false);
      scrollToBottom();
    } else {
      unreadCounts[friendId] = (unreadCounts[friendId] || 0) + 1;
    }
    renderChatList();
  });

  api.on('screen-locked', () => {
    document.getElementById('lock-screen').classList.remove('hidden');
    document.getElementById('lock-pin').value = '';
    document.getElementById('lock-pin').focus();
  });

  api.on('in-app-notify', ({ title, body }) => {
    showInAppNotif(title, body);
  });

  // ── WebRTC ──
  api.on('webrtc-offer', async ({ fromId, offer, callType }) => {
    if (!offer || !offer.type || !offer.sdp) {
      console.error('Received invalid offer:', offer);
      return;
    }

    if (peerConnection) {
      api.endWebRTC(fromId);
      showInAppNotif('Busy', `Missed call from ${friends.find(f=>f.id===fromId)?.name || fromId} — you were in another call.`);
      return;
    }

    callIncoming = { fromId, offer, callType: callType || 'video' };
    const friend = friends.find(f => f.id === fromId);

    const av = document.getElementById('incoming-avatar');
    av.innerHTML = '';
    renderAvatarEl(av, friend?.name || fromId, friend?.color, friend?.avatar, 64);
    av.style.borderRadius = '50%';

    document.getElementById('incoming-name').textContent = friend?.name || fromId;
    const typeLabel = callType === 'audio' ? '📞 Incoming audio call' : callType === 'screen' ? '🖥️ Incoming screen share' : '📹 Incoming video call';
    document.getElementById('incoming-type').textContent = typeLabel;
    document.getElementById('incoming-call').classList.remove('hidden');
  });

  api.on('webrtc-answer', async ({ fromId, answer }) => {
    if (!peerConnection) return;
    if (!answer || !answer.type || !answer.sdp) {
      console.error('Received invalid answer:', answer);
      return;
    }
    if (peerConnection.signalingState === 'have-local-offer') {
      try {
        const remoteDesc = new RTCSessionDescription({ type: answer.type, sdp: answer.sdp });
        await peerConnection.setRemoteDescription(remoteDesc);

        // Drain queued ICE candidates
        for (const candidate of pendingIceCandidates) {
          try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
        }
        pendingIceCandidates = [];

        // ── FIX: Host also marks as "Connected" when answer is received ──
        // The host's ontrack fires once media arrives; update status optimistically here
        // so the host doesn't stay stuck on "Calling..." while receiver already shows "Connected"
        const statusEl = document.getElementById('call-status');
        if (statusEl && statusEl.textContent !== 'Connected') {
          statusEl.textContent = 'Connected';
        }
      } catch (e) {
        console.error('Error setting remote description:', e);
        showInAppNotif('Call Error', 'Failed to connect: ' + e.message);
        endCall();
      }
    }
  });

  api.on('webrtc-ice', async ({ fromId, candidate }) => {
    if (!candidate) return;
    if (peerConnection && peerConnection.remoteDescription) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        // ICE add errors are common and non-fatal
      }
    } else {
      pendingIceCandidates.push(candidate);
    }
  });

  api.on('webrtc-end', ({ fromId }) => {
    const friend = friends.find(f => f.id === fromId);
    if (callIncoming && callIncoming.fromId === fromId) {
      document.getElementById('incoming-call').classList.add('hidden');
      callIncoming = null;
      showInAppNotif('Call Cancelled', `${friend?.name || fromId} cancelled the call.`);
      return;
    }
    endCall();
    showInAppNotif('Call Ended', `${friend?.name || fromId} ended the call`);
  });

  api.on('webrtc-annotation', ({ fromId, data }) => {
    // receiveAnnotation handles only drawing on the REMOTE layer, never re-sends
    receiveAnnotation(data, fromId);
  });

  api.on('webrtc-caption', ({ fromId, text }) => {
    showCaption(text, fromId, true);
    const el = document.getElementById('caption-display');
    if (el) el.classList.remove('hidden');
  });
}

// ─── Event Listeners ────────────────────────────────────
function setupEventListeners() {
  setupSetupModal();

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    renderChatList(q);
    renderGroupList(q);
  });

  document.getElementById('search-msg-btn').addEventListener('click', openChatSearchModal);

  setupDragDrop();

  document.getElementById('send-btn').addEventListener('click', sendMessage);
  document.getElementById('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  document.getElementById('msg-input').addEventListener('input', () => {
    if (!activeConversation || activeConversation.type !== 'friend') return;
    api.typingStart(activeConversation.id);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => api.typingStop(activeConversation.id), 2000);
  });

  document.getElementById('attach-btn').addEventListener('click', () => {
    if (!activeConversation || activeConversation.type !== 'friend') return;
    api.openFileDialog(activeConversation.id);
  });

  document.getElementById('emoji-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('emoji-picker').classList.toggle('hidden');
  });
  document.addEventListener('click', () => document.getElementById('emoji-picker').classList.add('hidden'));

  document.getElementById('reply-cancel').addEventListener('click', () => {
    replyToMsg = null;
    document.getElementById('reply-preview').classList.add('hidden');
  });

  document.getElementById('btn-minimize').addEventListener('click', () => api.windowMinimize());
  document.getElementById('btn-maximize').addEventListener('click', () => api.windowMaximize());
  document.getElementById('btn-close').addEventListener('click', () => api.windowClose());

  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.add('hidden');
  });

  document.getElementById('lock-btn').addEventListener('click', () => api.lockScreen());
  document.getElementById('lock-unlock-btn').addEventListener('click', unlockScreen);
  document.getElementById('lock-pin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlockScreen();
  });

  document.getElementById('create-group-btn').addEventListener('click', openCreateGroupModal);
  document.getElementById('group-create-submit').addEventListener('click', submitCreateGroup);

  document.getElementById('call-btn').addEventListener('click', () => {
    if (activeConversation?.type !== 'friend') return;
    if (!supportsWebRTC()) {
      showPermissionModal('video');
      return;
    }
    startCall(activeConversation.id, 'video');
  });

  document.getElementById('audio-call-btn').addEventListener('click', () => {
    if (activeConversation?.type !== 'friend') return;
    if (!supportsWebRTC()) {
      showPermissionModal('audio');
      return;
    }
    startCall(activeConversation.id, 'audio');
  });

  document.getElementById('call-end-btn').addEventListener('click', endCall);
  document.getElementById('call-mute-btn').addEventListener('click', toggleMute);
  document.getElementById('call-cam-btn').addEventListener('click', toggleCam);
  document.getElementById('call-caption-btn').addEventListener('click', toggleCaptions);

  document.getElementById('call-share-btn').addEventListener('click', () => {
    if (!supportsWebRTC()) {
      showPermissionModal('screen');
      return;
    }
    if (callFriendId && currentCallType === 'video') {
      const fid = callFriendId;
      endCall();
      setTimeout(() => startCall(fid, 'screen'), 300);
    } else if (!callFriendId && activeConversation?.type === 'friend') {
      startCall(activeConversation.id, 'screen');
    }
  });

  document.getElementById('incoming-accept').addEventListener('click', acceptIncomingCall);
  document.getElementById('incoming-reject').addEventListener('click', rejectIncomingCall);

  document.getElementById('annot-draw-btn').addEventListener('click', () => {
    enableAnnotation(true);
    document.getElementById('annot-draw-btn').classList.add('active');
    document.getElementById('annot-pointer-btn').classList.remove('active');
  });
  document.getElementById('annot-pointer-btn').addEventListener('click', () => {
    enableAnnotation(false);
    document.getElementById('annot-pointer-btn').classList.add('active');
    document.getElementById('annot-draw-btn').classList.remove('active');
  });
  document.getElementById('annot-clear-btn').addEventListener('click', clearAnnotation);
  document.getElementById('annot-color').addEventListener('input', (e) => { drawColor = e.target.value; });
  document.getElementById('annot-size').addEventListener('input', (e) => { drawSize = parseInt(e.target.value); });

  document.getElementById('chat-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('chat-menu-popup').classList.toggle('hidden');
  });
  document.getElementById('menu-view-profile').addEventListener('click', () => {
    document.getElementById('chat-menu-popup').classList.add('hidden');
    if (activeConversation?.type === 'friend') showFriendProfile(activeConversation.id);
  });
  document.getElementById('menu-toggle-notif').addEventListener('click', async () => {
    document.getElementById('chat-menu-popup').classList.add('hidden');
    await toggleConversationNotifications();
  });
  document.getElementById('menu-download-chat').addEventListener('click', async () => {
    document.getElementById('chat-menu-popup').classList.add('hidden');
    if (!activeConversation || activeConversation.type !== 'friend') return;
    await downloadChatHistory(activeConversation.id);
  });
  document.getElementById('menu-clear-chat').addEventListener('click', async () => {
    document.getElementById('chat-menu-popup').classList.add('hidden');
    if (!activeConversation) return;
    if (!confirm('Clear all messages in this chat?')) return;
    if (activeConversation.type === 'friend') {
      await api.clearChat(activeConversation.id);
      lastMessages[activeConversation.id] = null;
      renderMessages([], false);
      renderChatList();
    } else {
      renderMessages([], true);
    }
  });
  document.getElementById('menu-remove-friend').addEventListener('click', () => {
    document.getElementById('chat-menu-popup').classList.add('hidden');
    if (activeConversation?.type !== 'friend') return;
    const friend = friends.find(f => f.id === activeConversation.id);
    if (confirm(`Remove ${friend?.name || 'this friend'}?`)) {
      api.removeFriend(activeConversation.id);
      activeConversation = null;
      document.getElementById('chat-view').classList.add('hidden');
      document.getElementById('empty-state').classList.remove('hidden');
    }
  });
  document.addEventListener('click', () => {
    document.getElementById('chat-menu-popup').classList.add('hidden');
  });

  document.getElementById('select-delete-btn').addEventListener('click', deleteSelectedMessages);
  document.getElementById('select-cancel-btn').addEventListener('click', exitSelectMode);

  document.getElementById('settings-save-profile').addEventListener('click', saveProfile);
  document.getElementById('settings-change-avatar').addEventListener('click', async () => {
    const data = await api.pickAvatar();
    if (data) {
      myConfig.avatar = data;
      renderAvatarEl(document.getElementById('settings-avatar-display'), myConfig.name, myConfig.color, data, 72);
    }
  });
  document.getElementById('settings-save-pin').addEventListener('click', savePin);
  document.getElementById('settings-lock-now').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.add('hidden');
    api.lockScreen();
  });

  document.querySelectorAll('#settings-color-swatches .swatch').forEach(s => {
    s.addEventListener('click', () => {
      document.querySelectorAll('#settings-color-swatches .swatch').forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      applyThemeColor(s.dataset.color);
    });
  });

  document.getElementById('settings-theme-mode').addEventListener('change', (e) => {
    applyThemeMode(e.target.value);
    showInAppNotif('Theme Updated', `Switched to ${e.target.value} theme.`);
  });
}

// ─── Lock Screen ────────────────────────────────────────
async function unlockScreen() {
  const pin = document.getElementById('lock-pin').value;
  const ok = await api.unlockScreen(pin);
  if (ok) {
    document.getElementById('lock-screen').classList.add('hidden');
    document.getElementById('lock-error').classList.add('hidden');
  } else {
    document.getElementById('lock-error').classList.remove('hidden');
    document.getElementById('lock-pin').value = '';
    document.getElementById('lock-pin').focus();
  }
}

// ─── Settings ────────────────────────────────────────────
async function openSettings() {
  document.getElementById('settings-panel').classList.remove('hidden');
  updateSettingsPanel();
}

function updateSettingsPanel() {
  if (!myConfig.id) return;
  document.getElementById('settings-name').value = myConfig.name || '';
  document.getElementById('settings-status').value = myConfig.status || 'Available';
  document.getElementById('settings-status-msg').value = myConfig.statusMsg || '';
  document.getElementById('settings-theme-mode').value = myConfig.themeMode || 'system';
  document.getElementById('settings-my-id').textContent = (myConfig.id || '').substring(0, 16) + '...';
  document.getElementById('settings-peer-count').textContent = nearbyPeers.size;
  document.getElementById('settings-desktop-notif').checked = myConfig.notifications !== false;
  document.getElementById('settings-sound').checked = myConfig.sound !== false;

  renderAvatarEl(document.getElementById('settings-avatar-display'), myConfig.name, myConfig.color, myConfig.avatar, 72);

  document.querySelectorAll('#settings-color-swatches .swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === myConfig.color);
  });

  const netList = document.getElementById('settings-network-list');
  netList.innerHTML = '';
  nearbyPeers.forEach((peer) => {
    const row = document.createElement('div');
    row.className = 'network-peer-row';
    row.innerHTML = `<span>${escHtml(peer.name)}</span><code>${peer.ip}</code>`;
    netList.appendChild(row);
  });
}

async function saveProfile() {
  const name = document.getElementById('settings-name').value.trim();
  const status = document.getElementById('settings-status').value;
  const statusMsg = document.getElementById('settings-status-msg').value.trim();
  const themeMode = document.getElementById('settings-theme-mode').value;
  const activeColorSwatch = document.querySelector('#settings-color-swatches .swatch.active');
  const color = activeColorSwatch ? activeColorSwatch.dataset.color : myConfig.color;
  const notifications = document.getElementById('settings-desktop-notif').checked;
  const sound = document.getElementById('settings-sound').checked;

  if (!name) return;

  myConfig = await api.updateConfig({ name, status, statusMsg, themeMode, color, notifications, sound, avatar: myConfig.avatar });
  applyThemeColor(color);
  applyThemeMode(themeMode);
  renderMyProfile();
  renderChatList();

  const btn = document.getElementById('settings-save-profile');
  btn.textContent = 'Saved ✓';
  setTimeout(() => { btn.textContent = 'Save Profile'; }, 2000);
}

async function savePin() {
  const pin = document.getElementById('settings-pin').value;
  await api.updateConfig({ pin });
  const btn = document.getElementById('settings-save-pin');
  btn.textContent = 'Saved ✓';
  setTimeout(() => { btn.textContent = 'Set PIN'; }, 2000);
}

// ─── Create Group Modal ──────────────────────────────────
function openCreateGroupModal() {
  if (friends.length === 0) {
    showInAppNotif('No Friends', 'Add friends first before creating a group.');
    return;
  }
  document.getElementById('create-group-modal').classList.remove('hidden');
  document.getElementById('group-name-input').value = '';
  document.getElementById('group-name-input').focus();
  const list = document.getElementById('group-member-list');
  list.innerHTML = '';
  friends.forEach(f => {
    const label = document.createElement('label');
    label.className = 'member-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = f.id;
    const av = document.createElement('span');
    av.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:${f.color||'#6366f1'};color:#fff;font-size:11px;font-weight:700;margin-right:8px;`;
    av.textContent = f.name.charAt(0).toUpperCase();
    label.appendChild(cb);
    label.appendChild(av);
    label.appendChild(document.createTextNode(f.name));
    list.appendChild(label);
  });
}

function submitCreateGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) { document.getElementById('group-name-input').focus(); return; }
  const checked = Array.from(document.querySelectorAll('#group-member-list input:checked')).map(i => i.value);
  if (checked.length === 0) { showInAppNotif('Select Members', 'Select at least one member.'); return; }
  api.createGroup(name, checked);
  document.getElementById('create-group-modal').classList.add('hidden');
}

// ─── Emoji Picker ────────────────────────────────────────
function buildEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  EMOJIS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.getElementById('msg-input');
      input.value += emoji;
      input.focus();
      picker.classList.add('hidden');
    });
    picker.appendChild(btn);
  });
}

// ─── Helpers ─────────────────────────────────────────────
function scrollToBottom() {
  const wrap = document.getElementById('messages-wrap');
  setTimeout(() => { wrap.scrollTop = wrap.scrollHeight; }, 50);
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatShortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(ext) {
  const map = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', zip:'🗜️', rar:'🗜️', '7z':'🗜️', mp3:'🎵', mp4:'🎬', mov:'🎬', avi:'🎬', txt:'📃', png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', webp:'🖼️', ppt:'📊', pptx:'📊' };
  return map[ext] || '📁';
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="#" style="color:inherit;opacity:0.8;text-decoration:underline;" onclick="return false;">$1</a>');
}
document.getElementById('copyright-year').textContent =
  new Date().getFullYear();