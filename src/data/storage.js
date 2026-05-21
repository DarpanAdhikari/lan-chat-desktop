const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const userDataPath = app.getPath('userData');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filename) {
  const file = path.join(userDataPath, filename);
  ensureDir(file);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

function writeJSON(filename, data) {
  const file = path.join(userDataPath, filename);
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function getConfig() {
  const config = readJSON('config.json') || { id: '', name: '', color: '#6366f1', status: 'Available', notifications: true, themeMode: 'system' };
  return {
    id: '',
    name: '',
    avatar: null,
    color: '#6366f1',
    status: 'Available',
    notifications: true,
    themeMode: 'system',
    mutedChats: {},
    mutedGroups: {},
    locked: false,
    pin: '',
    ...config
  };
}
function setConfig(c)        { writeJSON('config.json', c); }
function getFriends()        { return readJSON('friends.json') || []; }
function setFriends(f)       { writeJSON('friends.json', f); }
function getFriendReq()      { return readJSON('friendRequests.json') || []; }
function setFriendReq(r)     { writeJSON('friendRequests.json', r); }
function getChat(friendId)   { return readJSON(`chats/${friendId}.json`) || []; }
function saveChat(id, msgs)  { writeJSON(`chats/${id}.json`, msgs); }
function getGroups()         { return readJSON('groups.json') || []; }
function setGroups(g)        { writeJSON('groups.json', g); }
function getGroupChat(gid)   { return readJSON(`groupchats/${gid}.json`) || []; }
function saveGroupChat(gid, msgs) { writeJSON(`groupchats/${gid}.json`, msgs); }
// Offline message/file queue per friendId
function getOfflineQueue(friendId) { return readJSON(`offlinequeue/${friendId}.json`) || []; }
function saveOfflineQueue(friendId, queue) { writeJSON(`offlinequeue/${friendId}.json`, queue); }

module.exports = {
  getConfig, setConfig,
  getFriends, setFriends,
  getFriendReq, setFriendReq,
  getChat, saveChat,
  getGroups, setGroups,
  getGroupChat, saveGroupChat,
  getOfflineQueue, saveOfflineQueue
};