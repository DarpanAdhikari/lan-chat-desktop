const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateConfig: (updates) => ipcRenderer.invoke('update-config', updates),
  pickAvatar: () => ipcRenderer.invoke('pick-avatar'),

  // Screen capture sources
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // Friends
  getFriends: () => ipcRenderer.invoke('get-friends'),
  getFriendRequests: () => ipcRenderer.invoke('get-friend-requests'),
  getOnlinePeers: () => ipcRenderer.invoke('get-online-peers'),
  sendFriendRequest: (peer) => ipcRenderer.send('send-friend-request', peer),
  acceptFriendRequest: (fromId) => ipcRenderer.send('accept-friend-request', fromId),
  rejectFriendRequest: (fromId) => ipcRenderer.send('reject-friend-request', fromId),
  removeFriend: (friendId) => ipcRenderer.send('remove-friend', friendId),

  // Chat
  getChat: (friendId) => ipcRenderer.invoke('get-chat', friendId),
  sendMessage: (friendId, text, replyTo) => ipcRenderer.send('send-message', { friendId, text, replyTo }),
  sendReaction: (friendId, messageId, emoji) => ipcRenderer.send('send-reaction', { friendId, messageId, emoji }),
  typingStart: (friendId) => ipcRenderer.send('typing-start', { friendId }),
  typingStop: (friendId) => ipcRenderer.send('typing-stop', { friendId }),
  markRead: (friendId) => ipcRenderer.send('mark-read', { friendId }),
  deleteMessages: (friendId, messageIds) => ipcRenderer.invoke('delete-messages', { friendId, messageIds }),
  clearChat: (friendId) => ipcRenderer.invoke('clear-chat', friendId),

  // Files
  openFileDialog: (friendId) => ipcRenderer.invoke('open-file-dialog', { friendId }),
  sendFile: (friendId, filePath) => ipcRenderer.send('send-file', { friendId, filePath }),
  openFile: (friendId, fileName, isMine) => ipcRenderer.send('open-file', { friendId, fileName, isMine }),
  downloadFile: (friendId, fileName, isMine) => ipcRenderer.send('download-file', { friendId, fileName, isMine }),
  openFileLocation: (friendId, fileName, isMine) => ipcRenderer.send('open-file-location', { friendId, fileName, isMine }),

  // Groups
  getGroups: () => ipcRenderer.invoke('get-groups'),
  createGroup: (name, memberIds) => ipcRenderer.send('create-group', { name, memberIds }),
  updateGroup: (groupId, updates) => ipcRenderer.send('update-group', { groupId, updates }),
  sendGroupMessage: (groupId, text, replyTo) => ipcRenderer.send('send-group-message', { groupId, text, replyTo }),
  getGroupChat: (groupId) => ipcRenderer.invoke('get-group-chat', groupId),
  deleteGroupMessages: (groupId, messageIds) => ipcRenderer.invoke('delete-group-messages', { groupId, messageIds }),

  // WebRTC (video, audio, screen share)
  sendWebRTCOffer: (friendId, offer, callType) => ipcRenderer.send('webrtc-offer', { friendId, offer, callType }),
  sendWebRTCAnswer: (friendId, answer) => ipcRenderer.send('webrtc-answer', { friendId, answer }),
  sendWebRTCIce: (friendId, candidate) => ipcRenderer.send('webrtc-ice', { friendId, candidate }),
  endWebRTC: (friendId) => ipcRenderer.send('webrtc-end', { friendId }),
  sendAnnotation: (friendId, data) => ipcRenderer.send('webrtc-annotation', { friendId, data }),
  sendCaption: (friendId, text) => ipcRenderer.send('webrtc-caption', { friendId, text }),

  // Lock
  lockScreen: () => ipcRenderer.send('lock-screen'),
  unlockScreen: (pin) => ipcRenderer.invoke('unlock-screen', pin),

  // Events
  on: (channel, cb) => {
    const allowed = [
      'ask-name','window-ready','peer-discovered','friends-updated',
      'chat-message','group-message','groups-updated','group-created','in-app-notify',
      'peer-typing','read-receipt','message-reaction','file-progress','file-sent',
      'file-incoming','file-complete','screen-locked','webrtc-offer','webrtc-answer',
      'webrtc-ice','webrtc-end','webrtc-annotation','webrtc-caption',
      'message-status','offline-queue-flushed'
    ];
    if (allowed.includes(channel)) {
      const listener = (e, ...args) => cb(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});