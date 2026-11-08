// Ported from Game/Networking/UDPListener.cs. This is a *different* binary
// protocol from the text+XOR one on TCP: fixed-offset fields, big-endian
// ("network byte order") integers - Node's Buffer already reads/writes those
// natively, no manual byte-reversal needed like the C# does.
const { users, getChannel } = require('./state');
const { recordFrame, frameStruct } = require('./record');

const INITIAL = 0x1001;
const PING = 0x1010; // also the envelope for the "tunnel" (relay) sub-packets below

// Sub-command byte at offset 14 within a PING-type packet that means "relay
// this to another player" rather than "this is the handshake ping" (0x21).
// The reference doesn't decode what's *inside* - movement, aim, shooting -
// it just forwards the whole packet untouched between the two clients'
// public UDP endpoints, using itself as a rendezvous point.
const TUNNEL_SUBCOMMANDS = new Set([0x10, 0x30, 0x31, 0x32, 0x34]);

// Sample logger for reverse-engineering the tunnel payload: we're the relay
// point, so we already see every byte in plaintext - no external capture
// needed. Logs the first occurrence of each (sub-command, length) shape,
// then a periodic refresh so changing fields (position, angle) are visible
// across samples, without flooding the console every single frame.
const seenShapes = new Map();
function logTunnelSample(msg) {
  const key = `${msg[14]}:${msg.length}`;
  const count = (seenShapes.get(key) || 0) + 1;
  seenShapes.set(key, count);
  if (count === 1 || count % 20 === 0) {
    console.log(`[udp-tunnel] sub=0x${msg[14].toString(16)} len=${msg.length} #${count} hex=${msg.toString('hex')}`);
  }
}

// Same XOR idea as the TCP side, just applied to raw 6-byte IP:port blobs
// instead of a whole text packet. Values match Game/Networking/UDPListener.cs's
// UdpReader (its local "SendKey"/"ReceiveKey" names are swapped vs
// Core/Constants.cs, but the actual bytes used for each direction match).
const READ_KEY = 0xc3; // decrypting an endpoint the client sent us
const WRITE_KEY = 0x96; // encrypting an endpoint we send back

function readEndpoint(buf, offset) {
  const b = Buffer.from(buf.subarray(offset, offset + 6)).map((x) => x ^ READ_KEY);
  return { ip: `${b[2]}.${b[3]}.${b[4]}.${b[5]}`, port: b.readUInt16LE(0) };
}

function writeEndpoint(buf, offset, ip, port) {
  const octets = ip.split('.').map(Number);
  const value = Buffer.from([port & 0xff, (port >> 8) & 0xff, ...octets]).reverse();
  for (let i = 0; i < 6; i++) buf[offset + i] = value[i] ^ WRITE_KEY;
}

// type(u16 BE) @0, sessionId(u16 BE) @4. Client sends this on UDP1 (5350) to
// kick off the UDP side of the session; server replies with the same packet
// but pointing it at UDP2 (5350+1=5351) for whatever comes next.
function handleInitial(socket, msg, rinfo, port) {
  const reply = Buffer.from(msg);
  reply.writeUInt16BE(port + 1, 4);
  socket.send(reply, rinfo.port, rinfo.address);
}

// Client reports its own (local) ip:port at offset 32; server echoes back
// both that and the endpoint it actually saw the packet arrive from (they
// can differ behind NAT) so the client learns its real public address. This
// is also our only chance to learn the player's public UDP endpoint, needed
// below to relay movement/shooting packets to them later.
// The session id in a datagram is the sender's word. A player's UDP comes from the same IP as its TCP connection (NAT
// included; the source port may change between handshakes), so a handshake from any other IP is someone trying to take
// over that player's relay endpoint.
function tcpAddress(u) {
  const a = u.socket.remoteAddress || '';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

function handlePingHandshake(socket, msg, rinfo) {
  const sessionId = msg.readUInt16BE(4);
  const localEndpoint = readEndpoint(msg, 32);

  const u = users.get(sessionId);
  console.log(`[udp-handshake] session ${sessionId} on server port ${socket.address().port} from ${rinfo.address}:${rinfo.port} (client-reported local ${localEndpoint.ip}:${localEndpoint.port})`);
  if (u && tcpAddress(u) !== rinfo.address) {
    console.log(`[udp-handshake] session ${sessionId} refused: its TCP connection is from ${tcpAddress(u)}`);
    return;
  }

  const response = Buffer.alloc(65);
  msg.copy(response, 0, 0, Math.min(msg.length, 65));
  response[17] = 0x41;
  response[64] = 0x11;
  response.writeUInt16BE(sessionId, 4);
  writeEndpoint(response, 32, rinfo.address, rinfo.port);
  writeEndpoint(response, 50, localEndpoint.ip, localEndpoint.port);
  socket.send(response, rinfo.port, rinfo.address);

  // Cached so startUdpKeepalive() can resend this exact, already-valid reply
  // on its own timer - it's what keeps a NAT'd client's UDP mapping alive
  // between real movement/combat packets (see the keepalive doc comment).
  if (u) {
    u.udpEndpoint = { address: rinfo.address, port: rinfo.port };
    u.udpKeepaliveSocket = socket;
    u.udpKeepaliveMsg = response;
  }
}

// A client behind NAT (e.g. a VM on Hyper-V's Default Switch) has its UDP
// mapping torn down by the NAT after a few idle minutes - fine while a match
// keeps a steady stream of movement/combat UDP flowing, but during lobby
// idle time nothing goes over UDP at all, the mapping expires, and the
// client eventually decides the connection is dead and bails to the server
// list. NAT mappings refresh on *any* datagram matching the flow, in either
// direction - so periodically resending the same handshake reply already
// cached above is enough, no need to construct a new packet type the client
// has to specially understand.
const KEEPALIVE_MS = 60000;
function startUdpKeepalive() {
  setInterval(() => {
    for (const u of users.values()) {
      if (!u.udpEndpoint || !u.udpKeepaliveSocket) continue;
      u.udpKeepaliveSocket.send(u.udpKeepaliveMsg, u.udpEndpoint.port, u.udpEndpoint.address);
    }
  }, KEEPALIVE_MS);
}

// Ported from the `else if (packet[14] == 0x10 || ...)` branch of
// UDPListener.Handle(). sessionId/room/targetId are all plain big-endian
// u16 fields (the reference reads sessionId via a byte-swap dance that
// works out to the same value as a direct big-endian read at offset 4).
// Both players must be confirmed in the same *Playing* room - otherwise
// this would be a free relay for anyone who guesses two session ids.
// WR_UDP_DUMP=<file>: append EVERY tunnel packet as JSON lines (t ms, sender session, sub, hex) - raw material for
// decoding the movement frame fields and, later, a training dataset. Off unless the env var is set.
const DUMP_FILE = process.env.WR_UDP_DUMP;
function dumpPacket(msg) {
  if (DUMP_FILE) require('fs').appendFileSync(DUMP_FILE, JSON.stringify({ t: Date.now(), s: msg.readUInt16BE(4), sub: msg[14], hex: msg.toString('hex') }) + '\n');
}

function handleTunnel(socket, msg, rinfo) {
  dumpPacket(msg);
  logTunnelSample(msg);
  const via = `${socket.address().port}<-${rinfo.address}:${rinfo.port}`; // local server port <- peer's source address (compare with its handshake endpoint)

  const sessionId = msg.readUInt16BE(4);
  const roomId = msg.readUInt16BE(6);
  const targetId = msg.readUInt16BE(22);

  const sender = users.get(sessionId);
  const target = users.get(targetId);
  if (!sender || !target || sender.roomId !== roomId || target.roomId !== roomId) return countRelay(sessionId, targetId, `drop:no-sender/target/room via ${via}`);
  // Only from the endpoint this session handshook from (real clients and the bot always do): stops frames injected as
  // another player, and keeps their recorded position honest.
  const from = sender.udpEndpoint;
  if (!from || from.address !== rinfo.address || from.port !== rinfo.port) return countRelay(sessionId, targetId, `drop:wrong-source via ${via}`);

  if (msg[14] === 0x31) {
    recordFrame(msg);
    const s = frameStruct(msg); // last known position, for gamesubs.js's knife range check
    if (s) sender.pos = { x: s.readFloatLE(28), h: s.readFloatLE(32), z: s.readFloatLE(36), t: Date.now() };
  }

  const room = getChannel(sender.channel).rooms.get(roomId);
  if (!room || room.state !== 2) return countRelay(sessionId, targetId, 'drop:not-playing'); // Playing

  if (!target.udpEndpoint) return countRelay(sessionId, targetId, 'drop:no-udp-endpoint');
  // Send from the server socket the TARGET handshook on (5350 for the real client): it only ever talked to that
  // address, and the packet is relayed from whichever port the *sender* used (5351 for the bot) otherwise.
  (target.udpKeepaliveSocket || socket).send(msg, target.udpEndpoint.port, target.udpEndpoint.address);
  countRelay(sessionId, targetId, `sent->${target.udpEndpoint.address}:${target.udpEndpoint.port} via ${via}`);
}

// Per sender->target counters, printed every 5s: tells at a glance whether a peer's packets are
// being relayed to the other client or silently dropped (and why).
const relayStats = new Map();
let relayTimer = null;
function countRelay(from, to, what) {
  const key = `${from}->${to} ${what}`;
  relayStats.set(key, (relayStats.get(key) || 0) + 1);
  if (relayTimer) return;
  relayTimer = setInterval(() => {
    if (relayStats.size) console.log(`[udp-relay/5s] ${[...relayStats].map(([k, n]) => `${k} x${n}`).join(' | ')}`);
    relayStats.clear();
  }, 5000).unref(); // logging only: must not keep a process (e.g. a test) alive
}

// Never throws: a throw in a dgram listener is an uncaught exception, and one 1-byte datagram used to kill the server.
function handleUdpPacket(socket, msg, rinfo, port) {
  try {
    dispatch(socket, msg, rinfo, port);
  } catch (err) {
    console.log(`UDP:${port} bad packet from ${rinfo.address}:${rinfo.port} (${msg.length} bytes): ${err.message}`);
  }
}

function dispatch(socket, msg, rinfo, port) {
  const type = msg.readUInt16BE(0);

  if (type === INITIAL) return handleInitial(socket, msg, rinfo, port);
  if (type === PING) {
    if (msg[14] === 0x21) return handlePingHandshake(socket, msg, rinfo);
    if (TUNNEL_SUBCOMMANDS.has(msg[14])) return handleTunnel(socket, msg, rinfo);
    return;
  }

  console.log(`UDP:${port} unhandled type=0x${type.toString(16)} from ${rinfo.address}:${rinfo.port}`);
}

module.exports = { handleUdpPacket, startUdpKeepalive };
