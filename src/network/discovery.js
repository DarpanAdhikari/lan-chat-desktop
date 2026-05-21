const dgram = require('dgram');
const { getConfig } = require('../data/storage');

const DISCOVERY_PORT = 54321;
let socket;

function startDiscovery(wsPort, onPeerUpdate) {
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    console.error('Discovery socket error:', err);
    try { socket.close(); } catch(e) {}
  });

  socket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'announce' && data.id && data.id !== getConfig().id) {
        onPeerUpdate({
          id: data.id,
          name: data.name,
          ip: rinfo.address,
          wsPort: data.wsPort,
          color: data.color,
          status: data.status
        });
      }
    } catch (e) {}
  });

  socket.bind(DISCOVERY_PORT, () => {
    try { socket.setBroadcast(true); } catch (e) {}
    setInterval(() => {
      const config = getConfig();
      if (!config.id) return;
      const message = JSON.stringify({
        type: 'announce',
        id: config.id,
        name: config.name,
        wsPort,
        color: config.color,
        status: config.status
      });
      const buf = Buffer.from(message);
      socket.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) {
          socket.send(buf, 0, buf.length, DISCOVERY_PORT, '192.168.1.255');
        }
      });
    }, 3000);
  });
}

module.exports = { startDiscovery };