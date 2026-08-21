const net = require('net');
const config = require('./config.json');
const { createPool } = require('./lib/db');
const { wrapSocket, sendGreeting } = require('./lib/xor-socket');
const { PORTS, XOR } = require('./lib/constants');
const { createHandlers } = require('./auth/handlers');
const internalHandlers = require('./auth/internal-handlers');

function logPacket(label, pkt) {
  console.log(`${label} tick=${pkt.tick} id=${pkt.id} blocks=[${pkt.blocks.join(', ')}]`);
}

function startListener(port, keys, label, handlers = {}) {
  const server = net.createServer((socket) => {
    console.log(`${label}: connection from ${socket.remoteAddress}:${socket.remotePort}`);
    wrapSocket(socket, keys, (pkt) => {
      logPacket(`${label} IN`, pkt);
      const handler = handlers[pkt.id];
      if (handler) Promise.resolve(handler(socket, pkt)).catch((err) => console.error(`${label} handler id=${pkt.id} failed:`, err.message));
    });
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

  startListener(PORTS.login, XOR.external, 'Login', createHandlers(db));
  startListener(PORTS.internal, XOR.internalAuth, 'Internal', internalHandlers);
}

main().catch((err) => {
  console.error('Authorization server failed to start:', err.message);
  process.exit(1);
});
