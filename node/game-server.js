const net = require('net');
const dgram = require('dgram');
const config = require('./config.json');
const { createPool } = require('./lib/db');
const { wrapSocket, sendGreeting } = require('./lib/xor-socket');
const { PORTS, XOR } = require('./lib/constants');
const { connectToAuthServer } = require('./game/internal-client');
const { createHandlers } = require('./game/handlers');
const { handleUdpPacket } = require('./game/udp-handlers');
const { loadGameConfig } = require('./game/progression');
const { startPingLoop } = require('./game/ping');
const { loadClans } = require('./game/clan');
const { loadItems } = require('./game/items');
const { loadCoupons } = require('./game/coupon');

function logPacket(label, pkt) {
  console.log(`${label} tick=${pkt.tick} id=${pkt.id} blocks=[${pkt.blocks.join(', ')}]`);
}

async function main() {
  const db = createPool(config.game.db);
  await db.query('SELECT 1');
  console.log('Game server: DB ok.');
  await loadGameConfig(db);
  await loadClans(db);
  await loadItems(db);
  await loadCoupons(db);

  const handlers = createHandlers(db);
  const gameListener = net.createServer((socket) => {
    console.log(`Game: connection from ${socket.remoteAddress}:${socket.remotePort}`);
    wrapSocket(socket, XOR.external, (pkt) => {
      logPacket('Game IN', pkt);
      const handler = handlers[pkt.id];
      // A rejected/thrown handler must never crash the whole process over
      // one bad packet - it did exactly that once (an async DB error in a
      // GM command with no catch anywhere up the call chain).
      if (handler) Promise.resolve(handler(socket, pkt)).catch((err) => console.error(`Game handler id=${pkt.id} failed:`, err.message));
    });
    sendGreeting(socket);
    socket.on('close', () => console.log('Game: disconnected'));
    socket.on('error', (err) => console.log(`Game: socket error: ${err.message}`));
  });
  gameListener.listen(PORTS.game, () => console.log(`Game: listening on ${PORTS.game}`));

  for (const port of [PORTS.udp1, PORTS.udp2]) {
    const udp = dgram.createSocket('udp4');
    udp.on('message', (msg, rinfo) => handleUdpPacket(udp, msg, rinfo, port));
    udp.bind(port, () => console.log(`UDP: listening on ${port}`));
  }

  connectToAuthServer(config.game);
  startPingLoop(db);
}

main().catch((err) => {
  console.error('Game server failed to start:', err.message);
  process.exit(1);
});
