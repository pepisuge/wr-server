const net = require('net');
const dgram = require('dgram');
const config = require('./config.json');
const { createPool } = require('./lib/db');
const { wrapSocket, sendGreeting } = require('./lib/xor-socket');
const { PORTS, XOR } = require('./lib/constants');
const { connectToAuthServer } = require('./game/internal-client');
const { createHandlers } = require('./game/handlers');
const { handleUdpPacket, startUdpKeepalive } = require('./game/udp-handlers');
const { loadGameConfig } = require('./game/progression');
const { startPingLoop } = require('./game/ping');
const { loadClans } = require('./game/clan');
const { loadItems } = require('./game/items');
const { loadCoupons } = require('./game/coupon');
const { loadMaps } = require('./game/maps');
const { setAuthDb } = require('./game/gm');

function logPacket(label, pkt) {
  console.log(`${label} tick=${pkt.tick} id=${pkt.id} blocks=[${pkt.blocks.join(', ')}]`);
}

async function main() {
  const db = createPool(config.game.db);
  await db.query('SELECT 1');
  console.log('Game server: DB ok.');

  // /ban and /unban (gm.js) mutate the auth DB's users.status - the same
  // column auth/handlers.js already checks at login - so the game process
  // needs its own small connection there too, separate from the `db` pool
  // above (which only ever points at the game DB, wres2).
  const authDb = createPool(config.auth.db);
  await authDb.query('SELECT 1');
  setAuthDb(authDb);
  await loadGameConfig(db);
  await loadClans(db);
  await loadItems(db);
  await loadCoupons(db);
  await loadMaps(db);

  const handlers = createHandlers(db);
  const gameListener = net.createServer((socket) => {
    console.log(`Game: connection from ${socket.remoteAddress}:${socket.remotePort}`);
    wrapSocket(socket, XOR.external, (pkt) => {
      logPacket('Game IN', pkt);
      const handler = handlers[pkt.id];
      // A rejected/thrown handler must never crash the whole process over
      // one bad packet - it did exactly that twice: once from an async DB
      // error in a GM command, and once from a handler throwing
      // synchronously (Promise.resolve(handler(...)) only wraps the call
      // *after* it returns, so a sync throw escapes the .catch() below
      // entirely - the try/catch is what actually closes that gap).
      if (handler) {
        try {
          Promise.resolve(handler(socket, pkt)).catch((err) => console.error(`Game handler id=${pkt.id} failed:`, err.message));
        } catch (err) {
          console.error(`Game handler id=${pkt.id} failed:`, err.message);
        }
      }
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
  startUdpKeepalive();
}

main().catch((err) => {
  console.error('Game server failed to start:', err.message);
  process.exit(1);
});
