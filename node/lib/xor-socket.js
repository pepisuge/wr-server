const { xorBuffer, parsePacket, buildPacket } = require('./packet');

const MAX_LINE = 64 * 1024;

// Wraps a TCP socket: decrypts incoming bytes, splits them into lines (0x0A),
// and calls onPacket for each complete packet. Adds socket.sendPacket() for
// encoding + XOR-encrypting an outgoing packet.
function wrapSocket(socket, keys, onPacket) {
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    const decoded = xorBuffer(chunk, keys.receive);
    buffer = buffer.length === 0 ? decoded : Buffer.concat([buffer, decoded]);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, newlineIndex + 1);
      buffer = buffer.subarray(newlineIndex + 1);
      if (line.length > 1) onPacket(parsePacket(line));
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

module.exports = { wrapSocket, sendGreeting, broadcastPacket };
