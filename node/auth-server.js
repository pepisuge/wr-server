const net = require('net');
const config = require('./lib/config');
const { createPool } = require('./lib/db');
const { wrapSocket, sendGreeting, admitConnection, MAX_PACKETS_PER_SEC } = require('./lib/xor-socket');
const { PORTS, XOR } = require('./lib/constants');
const { DEBUG } = require('./lib/log');
const { createHandlers } = require('./auth/handlers');
const internalHandlers = require('./auth/internal-handlers');

// blocks[3] of a login (0x1100) is the plaintext password: never write it to the log.
function logPacket(label, pkt) {
  if (!DEBUG) return;
  const blocks = pkt.id === 0x1100 ? pkt.blocks.map((b, i) => (i === 3 ? '***' : b)) : pkt.blocks;
  console.log(`${label} tick=${pkt.tick} id=${pkt.id} blocks=[${blocks.join(', ')}]`);
}

// clientFacing: per-IP connection cap and packet budget (lib/xor-socket.js); the internal channel has neither.
function startListener(port, keys, label, handlers = {}, clientFacing = false) {
  const server = net.createServer((socket) => {
    console.log(`${label}: connection from ${socket.remoteAddress}:${socket.remotePort}`);
    if (clientFacing && !admitConnection(socket)) return;
    wrapSocket(socket, keys, (pkt) => {
      logPacket(`${label} IN`, pkt);
      const handler = handlers[pkt.id];
      // Same fix as game-server.js: Promise.resolve(handler(...)) only
      // catches a rejected promise, not a handler that throws synchronously
      // before returning one - the try/catch is what actually stops a bad
      // packet from taking down the whole process.
      if (handler) {
        try {
          Promise.resolve(handler(socket, pkt)).catch((err) => console.error(`${label} handler id=${pkt.id} failed:`, err.message));
        } catch (err) {
          console.error(`${label} handler id=${pkt.id} failed:`, err.message);
        }
      }
    }, clientFacing ? MAX_PACKETS_PER_SEC : Infinity);
    sendGreeting(socket);
    socket.on('close', () => console.log(`${label}: disconnected`));
    socket.on('error', (err) => console.log(`${label}: socket error: ${err.message}`));
  });
  server.listen(port, () => console.log(`${label}: listening on ${port}`));
  return server;
}

async function main() {
  const db = createPool(config.auth.db);
  await db.query('SELECT 1');
  console.log('Authorization server: DB ok.');

  startListener(PORTS.login, XOR.external, 'Login', createHandlers(db), true);
  startListener(PORTS.internal, XOR.internalAuth, 'Internal', internalHandlers);
}

main().catch((err) => {
  console.error('Authorization server failed to start:', err.message);
  process.exit(1);
});
