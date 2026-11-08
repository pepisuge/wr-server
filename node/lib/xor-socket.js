const { xorBuffer, parsePacket, buildPacket } = require('./packet');

const MAX_LINE = 64 * 1024;
// Client-facing limits (not the internal Auth<->Game channel). Real clients peak at ~5 packets/s per connection.
// Behind Docker Desktop / a proxy every client shares one source IP: raise WR_MAX_CONN_PER_IP there.
const MAX_PACKETS_PER_SEC = 50;
const MAX_CONN_PER_IP = Number(process.env.WR_MAX_CONN_PER_IP) || 10;

const connections = new Map(); // remote IP -> open client connections

// Call first thing on a new client connection: false (socket destroyed) when that IP already has too many open.
function admitConnection(socket) {
  const ip = socket.remoteAddress;
  const n = connections.get(ip) || 0;
  if (n >= MAX_CONN_PER_IP) {
    console.log(`refused connection from ${ip}: ${n} already open`);
    socket.destroy();
    return false;
  }
  connections.set(ip, n + 1);
  socket.once('close', () => {
    const left = connections.get(ip) - 1;
    if (left > 0) connections.set(ip, left);
    else connections.delete(ip);
  });
  return true;
}

// Wraps a TCP socket: decrypts incoming bytes, splits them into lines (0x0A),
// and calls onPacket for each complete packet. Adds socket.sendPacket() for
// encoding + XOR-encrypting an outgoing packet. A peer sending more than
// maxPacketsPerSec packets in a one-second window is disconnected.
function wrapSocket(socket, keys, onPacket, maxPacketsPerSec = Infinity) {
  let buffer = Buffer.alloc(0);
  let windowStart = 0;
  let count = 0;

  socket.on('data', (chunk) => {
    const decoded = xorBuffer(chunk, keys.receive);
    buffer = buffer.length === 0 ? decoded : Buffer.concat([buffer, decoded]);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, newlineIndex + 1);
      buffer = buffer.subarray(newlineIndex + 1);
      if (line.length <= 1) continue;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > maxPacketsPerSec) {
        console.log(`disconnected ${socket.remoteAddress}: over ${maxPacketsPerSec} packets/s`);
        socket.destroy();
        return;
      }
      onPacket(parsePacket(line));
    }
    // A peer that never sends a newline would grow this forever; real packets are a few KB at most.
    if (buffer.length > MAX_LINE) socket.destroy();
  });

  socket.sendPacket = (id, fields) => {
    console.log(`OUT id=${id} fields=[${fields.join(', ')}]`);
    socket.write(xorBuffer(buildPacket(id, fields), keys.send));
  };
}

// First packet the server sends on every new connection (login, game, and
// the internal channel all use this same greeting, id 0x1200). Field 1 is a
// random 9-digit nonce, field 2 is a constant "77" - both just copied as-is
// from Core/Packets/Connection.cs, their real purpose isn't clear yet.
function sendGreeting(socket) {
  const nonce = 111111111 + Math.floor(Math.random() * (999999999 - 111111111));
  socket.sendPacket(0x1200, [nonce, 77]);
}

// Same as socket.sendPacket, but for pushing the same packet to several
// sockets at once (room updates, chat) - built once, written many times.
function broadcastPacket(sockets, keys, id, fields) {
  console.log(`OUT(broadcast x${sockets.length}) id=${id} fields=[${fields.join(', ')}]`);
  const buf = xorBuffer(buildPacket(id, fields), keys.send);
  for (const s of sockets) s.write(buf);
}

module.exports = { wrapSocket, sendGreeting, broadcastPacket, admitConnection, MAX_PACKETS_PER_SEC };
