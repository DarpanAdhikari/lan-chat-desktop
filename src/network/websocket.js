const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getConfig } = require('../data/storage');

let wss;
let mainWindow;
const clients = new Map(); // friendId -> WebSocket
const pendingTransfers = new Map(); // transferId -> transfer state
const onConnectCallbacks = new Map(); // friendId -> callback

function setMainWindow(win) {
  mainWindow = win;
  global.mainWindow = win;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    wss = new WebSocket.Server({ port }, () => {
      resolve(wss.address().port);
    });

    wss.on('error', reject);

    wss.on('connection', (ws, req) => {
      const fromIp = req.socket.remoteAddress?.replace('::ffff:', '') || req.socket.remoteAddress;
      let friendId = null;

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          handleBinaryData(ws, data);
          return;
        }
        try {
          const msg = JSON.parse(data.toString());

          if (msg.fromId && !friendId) {
            friendId = msg.fromId;
            clients.set(friendId, ws);
          } else if (msg.fromId && friendId !== msg.fromId) {
            if (friendId) clients.delete(friendId);
            friendId = msg.fromId;
            clients.set(friendId, ws);
          }

          if (msg.type === 'file-start') {
            pendingTransfers.set(msg.transferId, {
              ws,
              friendId: msg.fromId,
              fromName: msg.fromName || msg.fromId,
              fileName: msg.fileName,
              fileSize: msg.fileSize,
              chunks: [],
              received: 0
            });
          }

          if (global.handleIncomingMessage) {
            global.handleIncomingMessage(msg, fromIp);
          }
        } catch (e) {
          console.error('WS parse error:', e);
        }
      });

      ws.on('close', () => {
        if (friendId) {
          clients.delete(friendId);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('peer-discovered', {
              id: friendId, name: '', ip: '', wsPort: 0, offline: true
            });
          }
        }
      });

      ws.on('error', (err) => console.error('WS connection error:', err.message));
    });
  });
}

function handleBinaryData(ws, data) {
  for (const [transferId, transfer] of pendingTransfers.entries()) {
    if (transfer.ws === ws) {
      transfer.chunks.push(Buffer.from(data));
      transfer.received += data.length;

      // Send progress to local receiver UI
      if (mainWindow && !mainWindow.isDestroyed() && transfer.fileSize > 0) {
        const progress = Math.min(99, Math.round((transfer.received / transfer.fileSize) * 100));
        mainWindow.webContents.send('file-progress', {
          friendId: transfer.friendId,
          msgId: transferId,
          progress
        });
      }

      if (transfer.received >= transfer.fileSize) {
        try {
          const receivedDir = path.join(app.getPath('userData'), 'ReceivedFiles', transfer.friendId);
          if (!fs.existsSync(receivedDir)) fs.mkdirSync(receivedDir, { recursive: true });

          let finalName = transfer.fileName;
          let filePath = path.join(receivedDir, finalName);
          let counter = 1;
          while (fs.existsSync(filePath)) {
            const ext = path.extname(transfer.fileName);
            const base = path.basename(transfer.fileName, ext);
            finalName = `${base} (${counter})${ext}`;
            filePath = path.join(receivedDir, finalName);
            counter++;
          }

          fs.writeFileSync(filePath, Buffer.concat(transfer.chunks));

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-progress', {
              friendId: transfer.friendId,
              msgId: transferId,
              progress: 100
            });
          }

          pendingTransfers.delete(transferId);

          if (global.handleIncomingMessage) {
            global.handleIncomingMessage({
              type: 'file-complete',
              fromId: transfer.friendId,
              fromName: transfer.fromName,
              fileName: finalName,
              fileSize: transfer.fileSize,
              transferId
            }, '');
          }
        } catch (err) {
          console.error('File write error:', err);
          pendingTransfers.delete(transferId);
        }
      }
      break;
    }
  }
}

function connectToPeer(ip, port, friendId = null, onOpen = null, onConnected = null) {
  const wsUrl = `ws://${ip}:${port}`;
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    return null;
  }

  ws.on('open', () => {
    const config = getConfig();
    ws.send(JSON.stringify({
      type: 'identity',
      fromId: config.id,
      fromName: config.name,
      color: config.color,
      status: config.status
    }));
    if (friendId) clients.set(friendId, ws);
    if (onOpen) onOpen(ws);
    if (onConnected) onConnected();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryData(ws, data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.fromId) {
        if (!friendId) friendId = msg.fromId;
        clients.set(msg.fromId, ws);
      }
      if (msg.type === 'file-start') {
        pendingTransfers.set(msg.transferId, {
          ws,
          friendId: msg.fromId,
          fromName: msg.fromName || msg.fromId,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          chunks: [],
          received: 0
        });
      }
      if (global.handleIncomingMessage) {
        global.handleIncomingMessage(msg, '');
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (friendId) clients.delete(friendId);
  });

  ws.on('error', (err) => {
    if (friendId) clients.delete(friendId);
  });

  return ws;
}

function sendToPeer(friendId, msg) {
  const ws = clients.get(friendId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {}
  }
  return false;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (e) {}
    }
  });
}

function sendFileToPeer(friendId, filePath, fileName, transferId, fileSize, onProgress) {
  const ws = clients.get(friendId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('No connection to peer:', friendId);
    return;
  }

  const config = getConfig();

  let actualSize = fileSize;
  if (!actualSize) {
    try { actualSize = fs.statSync(filePath).size; } catch(e) { return; }
  }

  // Signal start — receiver will show pending file bubble
  ws.send(JSON.stringify({
    type: 'file-start',
    fromId: config.id,
    fromName: config.name,
    fileName,
    fileSize: actualSize,
    transferId
  }));

  const CHUNK_SIZE = 64 * 1024;
  let sent = 0;
  let lastProgressReport = 0;

  function sendNextChunk() {
    if (!fs.existsSync(filePath)) {
      if (onProgress) onProgress(0);
      return;
    }

    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, actualSize - sent));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, sent);
    fs.closeSync(fd);

    if (bytesRead === 0) {
      ws.send(JSON.stringify({
        type: 'file-end',
        transferId,
        fromId: config.id,
        fromName: config.name,
        fileName,
        fileSize: actualSize
      }));
      if (onProgress) onProgress(100);
      return;
    }

    const chunk = buffer.slice(0, bytesRead);

    try {
      ws.send(chunk, { binary: true }, (err) => {
        if (err) { console.error('Chunk send error:', err); return; }
        sent += bytesRead;
        const progress = Math.min(99, Math.round((sent / actualSize) * 100));

        if (onProgress) onProgress(progress);

        // Relay progress to receiver via websocket message
        if (progress - lastProgressReport >= 5 || progress >= 99) {
          lastProgressReport = progress;
          try {
            ws.send(JSON.stringify({
              type: 'file-progress-relay',
              fromId: config.id,
              transferId,
              progress
            }));
          } catch(e) {}
        }

        if (sent < actualSize) {
          if (ws.bufferedAmount > CHUNK_SIZE * 4) {
            setTimeout(sendNextChunk, 10);
          } else {
            setImmediate(sendNextChunk);
          }
        } else {
          ws.send(JSON.stringify({
            type: 'file-end',
            transferId,
            fromId: config.id,
            fromName: config.name,
            fileName,
            fileSize: actualSize
          }));
          if (onProgress) onProgress(100);
        }
      });
    } catch (e) {
      console.error('Send chunk error:', e);
    }
  }

  sendNextChunk();
}

function getOnlinePeers() {
  return new Set(clients.keys());
}

module.exports = {
  startServer,
  connectToPeer,
  sendToPeer,
  sendFileToPeer,
  getOnlinePeers,
  broadcast,
  setMainWindow
};