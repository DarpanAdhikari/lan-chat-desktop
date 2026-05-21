const { app, BrowserWindow, ipcMain, Notification, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const crypto = require('crypto');
const {
  getConfig, setConfig, getFriends, setFriends,
  getFriendReq, setFriendReq, getChat, saveChat,
  getGroups, setGroups, getGroupChat, saveGroupChat,
  getOfflineQueue, saveOfflineQueue
} = require('./src/data/storage');
const { startDiscovery } = require('./src/network/discovery');
const {
  startServer, connectToPeer, sendToPeer,
  sendFileToPeer, getOnlinePeers, broadcast, setMainWindow
} = require('./src/network/websocket');

let mainWindow;
let wsPort;
let isLocked = false;

// ─── Window ─────────────────────────────────────────────
function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'logo', 'logo.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required for screen capture and media access
      webSecurity: true,
      devTools: false
    },
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f0f13',
    show: false
  });

  mainWindow.loadFile('renderer/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.send('window-ready');
  });

  setMainWindow(mainWindow);
}

// ─── Identity ────────────────────────────────────────────
async function ensureIdentity() {
  let config = getConfig();
  if (!config.id) {
    config.id = crypto.randomUUID();
    config.name = '';
    config.avatar = null;
    config.status = 'Available';
    config.color = randomColor();
    config.notifications = true;
    config.locked = false;
    config.pin = '';
    setConfig(config);
    mainWindow.webContents.send('ask-name');
  }
}

function randomColor() {
  const colors = ['#6366f1','#8b5cf6','#ec4899','#14b8a6','#f59e0b','#ef4444','#3b82f6','#10b981'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ─── Notifications ────────────────────────────────────────
function showNotification(title, body, opts = {}) {
  const config = getConfig();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('in-app-notify', { title, body });
  }
  if (config.notifications && Notification.isSupported() && mainWindow && !mainWindow.isFocused() && !isNotificationMuted(config, opts)) {
    new Notification({ title, body }).show();
  }
}

function isNotificationMuted(config, opts = {}) {
  if (opts.chatId && config.mutedChats?.[opts.chatId]) return true;
  if (opts.groupId && config.mutedGroups?.[opts.groupId]) return true;
  return false;
}

// ─── Offline Queue Processor ─────────────────────────────
function processOfflineQueue(friendId) {
  const queue = getOfflineQueue(friendId);
  if (!queue || queue.length === 0) return;

  const config = getConfig();
  const onlinePeers = getOnlinePeers();

  if (!onlinePeers.has(friendId)) return;

  const remaining = [];
  for (const item of queue) {
    try {
      if (item.type === 'message') {
        sendToPeer(friendId, {
          type: 'chat',
          id: item.id,
          from: config.id,
          fromName: config.name,
          text: item.text,
          time: item.time,
          replyTo: item.replyTo || null
        });
      } else if (item.type === 'file') {
        // Re-send file if it still exists
        const fs = require('fs');
        if (fs.existsSync(item.filePath)) {
          sendFileToPeer(friendId, item.filePath, item.fileName, item.msgId, (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('file-progress', { friendId, msgId: item.msgId, progress });
            }
            if (progress >= 100) {
              const c = getChat(friendId);
              const idx = c.findIndex(m => m.id === item.msgId);
              if (idx !== -1) { c[idx].status = 'sent'; saveChat(friendId, c); }
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('file-sent', { friendId, msgId: item.msgId });
              }
            }
          });
        }
      }
    } catch(e) {
      remaining.push(item);
    }
  }

  saveOfflineQueue(friendId, remaining);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('offline-queue-flushed', { friendId });
  }
}

// ─── IPC Handlers ──────────────────────────────────────
function setupIPC() {
  // ── Window controls ──
  ipcMain.on('window-minimize', () => mainWindow.minimize());
  ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
  ipcMain.on('window-close', () => mainWindow.close());

  // ── Config ──
  ipcMain.handle('get-config', () => getConfig());
  ipcMain.handle('update-config', (_, updates) => {
    const c = getConfig();
    Object.assign(c, updates);
    setConfig(c);
    broadcast({ type: 'profile-update', fromId: c.id, name: c.name, status: c.status, color: c.color, avatar: c.avatar });
    return c;
  });

  // ── Screen Sources for screen sharing ──
  ipcMain.handle('get-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 }
    });
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL()
    }));
  });

  // ── Friends ──
  ipcMain.handle('get-friends', () => getFriends());
  ipcMain.handle('get-friend-requests', () => getFriendReq());
  ipcMain.handle('get-online-peers', () => Array.from(getOnlinePeers()));

  // ── Friend Request ──
  ipcMain.on('send-friend-request', (_, { id, ip, port }) => {
    const config = getConfig();
    connectToPeer(ip, port, null, (ws) => {
      ws.send(JSON.stringify({
        type: 'friendRequest',
        fromId: config.id,
        fromName: config.name,
        fromColor: config.color,
        fromStatus: config.status
      }));
    });
  });

  ipcMain.on('accept-friend-request', (_, fromId) => {
    let requests = getFriendReq();
    const req = requests.find(r => r.fromId === fromId && r.status === 'pending');
    if (!req) return;
    requests = requests.filter(r => r.fromId !== fromId || r.status !== 'pending');
    setFriendReq(requests);
    let friends = getFriends();
    if (!friends.find(f => f.id === fromId)) {
      friends.push({ id: fromId, name: req.fromName, ip: req.fromIp || '', port: 0, color: req.fromColor || '#6366f1', status: req.fromStatus || 'Available', lastSeen: 0 });
      setFriends(friends);
    }
    mainWindow.webContents.send('friends-updated');
    sendToPeer(fromId, { type: 'friendAccepted', fromId: getConfig().id, fromName: getConfig().name });
  });

  ipcMain.on('reject-friend-request', (_, fromId) => {
    let requests = getFriendReq();
    requests = requests.filter(r => r.fromId !== fromId);
    setFriendReq(requests);
    mainWindow.webContents.send('friends-updated');
  });

  ipcMain.on('remove-friend', (_, friendId) => {
    let friends = getFriends();
    friends = friends.filter(f => f.id !== friendId);
    setFriends(friends);
    mainWindow.webContents.send('friends-updated');
  });

  // ── Chat ──
  ipcMain.handle('get-chat', (_, friendId) => getChat(friendId));

  ipcMain.on('send-message', (_, { friendId, text, replyTo }) => {
    const config = getConfig();
    const msg = { id: crypto.randomUUID(), from: 'me', text, time: Date.now(), replyTo: replyTo || null, status: 'sent' };
    const chat = getChat(friendId);
    chat.push(msg);
    saveChat(friendId, chat);

    const onlinePeers = getOnlinePeers();
    if (onlinePeers.has(friendId)) {
      sendToPeer(friendId, { type: 'chat', ...msg, from: config.id, fromName: config.name });
    } else {
      // Queue for offline delivery
      const queue = getOfflineQueue(friendId);
      queue.push({ type: 'message', id: msg.id, text, time: msg.time, replyTo: replyTo || null });
      saveOfflineQueue(friendId, queue);
      // Mark as queued
      const c = getChat(friendId);
      const idx = c.findIndex(m => m.id === msg.id);
      if (idx !== -1) { c[idx].status = 'queued'; saveChat(friendId, c); }
      mainWindow.webContents.send('message-status', { friendId, msgId: msg.id, status: 'queued' });
    }
    mainWindow.webContents.send('chat-message', { friendId, ...msg });
  });

  ipcMain.on('send-reaction', (_, { friendId, messageId, emoji }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'reaction', messageId, emoji, fromId: config.id });
    mainWindow.webContents.send('message-reaction', { friendId, messageId, emoji, fromId: 'me' });
    const chat = getChat(friendId);
    const msgIdx = chat.findIndex(m => m.id === messageId);
    if (msgIdx !== -1) {
      if (!chat[msgIdx].reactions) chat[msgIdx].reactions = {};
      chat[msgIdx].reactions[emoji] = (chat[msgIdx].reactions[emoji] || 0) + 1;
      saveChat(friendId, chat);
    }
  });

  // ── Delete messages ──
  ipcMain.handle('delete-messages', (_, { friendId, messageIds }) => {
    let chat = getChat(friendId);
    chat = chat.filter(m => !messageIds.includes(m.id));
    saveChat(friendId, chat);
    return chat;
  });

  ipcMain.handle('clear-chat', (_, friendId) => {
    saveChat(friendId, []);
    return [];
  });

  // ── Files ──
  ipcMain.on('send-file', (_, { friendId, filePath }) => {
    const fileName = path.basename(filePath);
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    const config = getConfig();
    const msgId = crypto.randomUUID();
    const msg = { id: msgId, from: 'me', type: 'file', fileName, fileSize: stat.size, filePath, time: Date.now(), status: 'sending' };
    const chat = getChat(friendId);
    chat.push(msg);
    saveChat(friendId, chat);
    mainWindow.webContents.send('chat-message', { friendId, ...msg });

    const onlinePeers = getOnlinePeers();
    if (onlinePeers.has(friendId)) {
      _doSendFile(friendId, filePath, fileName, msgId, stat.size);
    } else {
      // Queue for later
      const queue = getOfflineQueue(friendId);
      queue.push({ type: 'file', msgId, filePath, fileName, fileSize: stat.size });
      saveOfflineQueue(friendId, queue);
      const c = getChat(friendId);
      const idx = c.findIndex(m => m.id === msgId);
      if (idx !== -1) { c[idx].status = 'queued'; saveChat(friendId, c); }
      mainWindow.webContents.send('message-status', { friendId, msgId, status: 'queued' });
    }
  });

  function _doSendFile(friendId, filePath, fileName, msgId, fileSize) {
    sendFileToPeer(friendId, filePath, fileName, msgId, fileSize, (progress) => {
      mainWindow.webContents.send('file-progress', { friendId, msgId, progress });
      if (progress >= 100) {
        const c = getChat(friendId);
        const idx = c.findIndex(m => m.id === msgId);
        if (idx !== -1) { c[idx].status = 'sent'; saveChat(friendId, c); }
        mainWindow.webContents.send('file-sent', { friendId, msgId });
      }
    });
  }
  global._doSendFile = _doSendFile;

  ipcMain.handle('open-file-dialog', async (_, { friendId }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    });
    if (!result.canceled) {
      for (const filePath of result.filePaths) {
        ipcMain.emit('send-file', null, { friendId, filePath });
      }
    }
  });

  ipcMain.on('open-file', (_, { friendId, fileName, isMine }) => {
    let filePath;
    if (isMine) {
      const chat = getChat(friendId);
      const msg = chat.find(m => m.fileName === fileName && m.from === 'me');
      filePath = msg?.filePath || path.join(app.getPath('userData'), 'ReceivedFiles', friendId, fileName);
    } else {
      filePath = path.join(app.getPath('userData'), 'ReceivedFiles', friendId, fileName);
    }
    shell.openPath(filePath);
  });

  ipcMain.on('download-file', async (_, { friendId, fileName, isMine }) => {
    let srcPath;
    if (isMine) {
      const chat = getChat(friendId);
      const msg = chat.find(m => m.fileName === fileName && m.from === 'me');
      srcPath = msg?.filePath;
    } else {
      srcPath = path.join(app.getPath('userData'), 'ReceivedFiles', friendId, fileName);
    }
    if (!srcPath) return;
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: fileName });
    if (!result.canceled && result.filePath) {
      const fs = require('fs');
      fs.copyFileSync(srcPath, result.filePath);
    }
  });

  ipcMain.on('open-file-location', (_, { friendId, fileName, isMine }) => {
    let filePath;
    if (isMine) {
      const chat = getChat(friendId);
      const msg = chat.find(m => m.fileName === fileName && m.from === 'me');
      filePath = msg?.filePath || path.join(app.getPath('userData'), 'ReceivedFiles', friendId, fileName);
    } else {
      filePath = path.join(app.getPath('userData'), 'ReceivedFiles', friendId, fileName);
    }
    shell.showItemInFolder(filePath);
  });

  // ── Groups ──
  ipcMain.handle('get-groups', () => getGroups());

  ipcMain.on('create-group', (_, { name, memberIds }) => {
    const config = getConfig();
    const group = {
      id: crypto.randomUUID(),
      name,
      creatorId: config.id,
      members: [config.id, ...memberIds],
      avatar: null,
      color: randomColor(),
      createdAt: Date.now()
    };
    const groups = getGroups();
    groups.push(group);
    setGroups(groups);
    for (const memberId of memberIds) {
      sendToPeer(memberId, { type: 'group-invite', group, fromId: config.id, fromName: config.name });
    }
    mainWindow.webContents.send('groups-updated');
    mainWindow.webContents.send('group-created', group);
  });

  ipcMain.on('update-group', (_, { groupId, updates }) => {
    const groups = getGroups();
    const idx = groups.findIndex(g => g.id === groupId);
    if (idx !== -1) {
      Object.assign(groups[idx], updates);
      setGroups(groups);
      const config = getConfig();
      for (const memberId of groups[idx].members) {
        if (memberId !== config.id) {
          sendToPeer(memberId, { type: 'group-update', groupId, updates, fromId: config.id });
        }
      }
      mainWindow.webContents.send('groups-updated');
    }
  });

  ipcMain.on('send-group-message', (_, { groupId, text, replyTo }) => {
    const config = getConfig();
    const groups = getGroups();
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const msg = {
      id: crypto.randomUUID(),
      from: config.id,
      fromName: config.name,
      fromColor: config.color,
      text,
      time: Date.now(),
      replyTo: replyTo || null
    };
    const chat = getGroupChat(groupId);
    chat.push(msg);
    saveGroupChat(groupId, chat);
    for (const memberId of group.members) {
      if (memberId !== config.id) {
        sendToPeer(memberId, { type: 'group-chat', groupId, ...msg });
      }
    }
    mainWindow.webContents.send('group-message', { groupId, ...msg });
  });

  ipcMain.handle('get-group-chat', (_, groupId) => getGroupChat(groupId));

  ipcMain.handle('delete-group-messages', (_, { groupId, messageIds }) => {
    let chat = getGroupChat(groupId);
    chat = chat.filter(m => !messageIds.includes(m.id));
    saveGroupChat(groupId, chat);
    return chat;
  });

  // ── WebRTC Signaling (video, audio, screen share) ──
  ipcMain.on('webrtc-offer', (_, { friendId, offer, callType }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'webrtc-offer', offer, fromId: config.id, callType: callType || 'video' });
  });
  ipcMain.on('webrtc-answer', (_, { friendId, answer }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'webrtc-answer', answer, fromId: config.id });
  });
  ipcMain.on('webrtc-ice', (_, { friendId, candidate }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'webrtc-ice', candidate, fromId: config.id });
  });
  ipcMain.on('webrtc-end', (_, { friendId }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'webrtc-end', fromId: config.id });
  });
  // Screen share annotation relay
  ipcMain.on('webrtc-annotation', (_, { friendId, data }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'webrtc-annotation', data, fromId: config.id });
  });
  // Caption relay
  ipcMain.on('webrtc-caption', (_, { friendId, text }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'webrtc-caption', text, fromId: config.id });
  });

  // ── Lock Screen ──
  ipcMain.on('lock-screen', () => {
    isLocked = true;
    mainWindow.webContents.send('screen-locked');
  });
  ipcMain.handle('unlock-screen', (_, pin) => {
    const config = getConfig();
    if (!config.pin || config.pin === pin) {
      isLocked = false;
      return true;
    }
    return false;
  });

  // ── Typing indicators ──
  ipcMain.on('typing-start', (_, { friendId }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'typing-start', fromId: config.id });
  });
  ipcMain.on('typing-stop', (_, { friendId }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'typing-stop', fromId: config.id });
  });

  // ── Message read receipts ──
  ipcMain.on('mark-read', (_, { friendId }) => {
    const config = getConfig();
    sendToPeer(friendId, { type: 'read-receipt', fromId: config.id });
  });

  // ── Avatar ──
  ipcMain.handle('pick-avatar', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
    });
    if (result.canceled) return null;
    const fs = require('fs');
    const data = fs.readFileSync(result.filePaths[0]);
    return `data:image/jpeg;base64,${data.toString('base64')}`;
  });
}

// ─── App Lifecycle ──────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();
  wsPort = await startServer(0);

  startDiscovery(wsPort, (peer) => {
    const friends = getFriends();
    const idx = friends.findIndex(f => f.id === peer.id);
    if (idx !== -1) {
      friends[idx].ip = peer.ip;
      friends[idx].port = peer.wsPort;
      friends[idx].lastSeen = Date.now();
      setFriends(friends);
      const online = getOnlinePeers();
      if (!online.has(peer.id)) {
        connectToPeer(peer.ip, peer.wsPort, peer.id, null, () => {
          // Peer connected - process offline queue
          setTimeout(() => processOfflineQueue(peer.id), 500);
        });
      } else {
        processOfflineQueue(peer.id);
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('peer-discovered', peer);
    }
  });

  global.handleIncomingMessage = (msg, fromIp) => {
    const { type } = msg;

    if (type === 'friendRequest') {
      let requests = getFriendReq();
      if (!requests.find(r => r.fromId === msg.fromId && r.status === 'pending')) {
        requests.push({ fromId: msg.fromId, fromName: msg.fromName, fromColor: msg.fromColor, fromIp, status: 'pending' });
        setFriendReq(requests);
      }
      mainWindow.webContents.send('friends-updated');
      showNotification('Friend Request', `${msg.fromName} wants to connect`);
    }
    else if (type === 'friendAccepted') {
      let friends = getFriends();
      if (!friends.find(f => f.id === msg.fromId)) {
        friends.push({ id: msg.fromId, name: msg.fromName, ip: fromIp, port: 0, color: '#6366f1', status: 'Available', lastSeen: Date.now() });
        setFriends(friends);
      }
      mainWindow.webContents.send('friends-updated');
      showNotification('Friend Request Accepted', `${msg.fromName} accepted your request`);
    }
    else if (type === 'chat') {
      const chat = getChat(msg.from);
      const existing = chat.find(m => m.id === msg.id);
      if (!existing) {
        chat.push({ id: msg.id, from: msg.from, text: msg.text, time: msg.time, replyTo: msg.replyTo || null, status: 'delivered' });
        saveChat(msg.from, chat);
        mainWindow.webContents.send('chat-message', { friendId: msg.from, id: msg.id, from: msg.from, text: msg.text, time: msg.time, replyTo: msg.replyTo || null });
        showNotification(msg.fromName || 'New Message', msg.text, { chatId: msg.from });
      }
    }
    else if (type === 'reaction') {
      const chat = getChat(msg.fromId);
      const msgIdx = chat.findIndex(m => m.id === msg.messageId);
      if (msgIdx !== -1) {
        if (!chat[msgIdx].reactions) chat[msgIdx].reactions = {};
        chat[msgIdx].reactions[msg.emoji] = (chat[msgIdx].reactions[msg.emoji] || 0) + 1;
        saveChat(msg.fromId, chat);
      }
      mainWindow.webContents.send('message-reaction', { friendId: msg.fromId, messageId: msg.messageId, emoji: msg.emoji, fromId: msg.fromId });
    }
    else if (type === 'typing-start') {
      mainWindow.webContents.send('peer-typing', { friendId: msg.fromId, typing: true });
    }
    else if (type === 'typing-stop') {
      mainWindow.webContents.send('peer-typing', { friendId: msg.fromId, typing: false });
    }
    else if (type === 'read-receipt') {
      mainWindow.webContents.send('read-receipt', { friendId: msg.fromId });
    }
    else if (type === 'profile-update') {
      let friends = getFriends();
      const idx = friends.findIndex(f => f.id === msg.fromId);
      if (idx !== -1) {
        friends[idx].name = msg.name || friends[idx].name;
        friends[idx].status = msg.status || friends[idx].status;
        friends[idx].color = msg.color || friends[idx].color;
        friends[idx].avatar = msg.avatar !== undefined ? msg.avatar : friends[idx].avatar;
        setFriends(friends);
        mainWindow.webContents.send('friends-updated');
      }
    }
    else if (type === 'group-invite') {
      const groups = getGroups();
      if (!groups.find(g => g.id === msg.group.id)) {
        groups.push(msg.group);
        setGroups(groups);
        mainWindow.webContents.send('groups-updated');
        showNotification('Group Invite', `${msg.fromName} added you to "${msg.group.name}"`, { groupId: msg.group.id });
      }
    }
    else if (type === 'group-update') {
      const groups = getGroups();
      const idx = groups.findIndex(g => g.id === msg.groupId);
      if (idx !== -1) {
        Object.assign(groups[idx], msg.updates);
        setGroups(groups);
        mainWindow.webContents.send('groups-updated');
      }
    }
    else if (type === 'group-chat') {
      const chat = getGroupChat(msg.groupId);
      if (!chat.find(m => m.id === msg.id)) {
        chat.push({ id: msg.id, from: msg.from, fromName: msg.fromName, fromColor: msg.fromColor, text: msg.text, time: msg.time, replyTo: msg.replyTo || null });
        saveGroupChat(msg.groupId, chat);
        mainWindow.webContents.send('group-message', { groupId: msg.groupId, id: msg.id, from: msg.from, fromName: msg.fromName, fromColor: msg.fromColor, text: msg.text, time: msg.time });
        const groups = getGroups();
        const group = groups.find(g => g.id === msg.groupId);
        showNotification(group ? group.name : 'Group Message', `${msg.fromName}: ${msg.text}`, { groupId: msg.groupId });
      }
    }
    else if (type === 'webrtc-offer') {
      mainWindow.webContents.send('webrtc-offer', { fromId: msg.fromId, offer: msg.offer, callType: msg.callType || 'video' });
    }
    else if (type === 'webrtc-answer') {
      mainWindow.webContents.send('webrtc-answer', { fromId: msg.fromId, answer: msg.answer });
    }
    else if (type === 'webrtc-ice') {
      mainWindow.webContents.send('webrtc-ice', { fromId: msg.fromId, candidate: msg.candidate });
    }
    else if (type === 'webrtc-end') {
      mainWindow.webContents.send('webrtc-end', { fromId: msg.fromId });
    }
    else if (type === 'webrtc-annotation') {
      mainWindow.webContents.send('webrtc-annotation', { fromId: msg.fromId, data: msg.data });
    }
    else if (type === 'webrtc-caption') {
      mainWindow.webContents.send('webrtc-caption', { fromId: msg.fromId, text: msg.text });
    }
    else if (type === 'file-start') {
      // Relay to renderer so receiver can show pending file message
      mainWindow.webContents.send('file-incoming', {
        fromId: msg.fromId,
        fromName: msg.fromName,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        transferId: msg.transferId
      });
    }
    else if (type === 'file-progress-relay') {
      // Progress update sent from sender to receiver via websocket
      mainWindow.webContents.send('file-progress', {
        friendId: msg.fromId,
        msgId: msg.transferId,
        progress: msg.progress
      });
    }
    else if (type === 'file-complete') {
      const chat = getChat(msg.fromId);
      const existing = chat.find(m => m.id === msg.transferId);
      if (!existing) {
        const newMsg = { id: msg.transferId, from: msg.fromId, type: 'file', fileName: msg.fileName, fileSize: msg.fileSize, time: Date.now(), status: 'received' };
        chat.push(newMsg);
        saveChat(msg.fromId, chat);
        mainWindow.webContents.send('file-complete', { friendId: msg.fromId, ...newMsg });
        showNotification('File Received', `${msg.fileName} from ${msg.fromName}`, { chatId: msg.fromId });
      }
    }
  };

  setupIPC();
  await ensureIdentity();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});