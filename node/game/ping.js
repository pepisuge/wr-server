// Ported from Game/Packets/Ping.cs. The reference sends this periodically to
// every connected user (a server-initiated push, not a reply) mainly so the
// client can show its premium-time countdown; it also carries a round-trip
// ping value, which we skip tracking - see the ponytail note below.
const { users } = require('./state');
const { GameConfig, checkPremiumExpiry } = require('./progression');

const PING = 0x6400;
const CHAT = 0x7400;
const NOTICE = 1; // Game/Enums/ChatType.cs Notice1 - see gm.js for why this is the "system message" type
const INTERVAL_MS = 5000;
// Non invasivo: 4 ping mancati (20s) prima di considerare la connessione
// morta - assorbe un lag/freeze temporaneo del client senza scollegarlo.
const PONG_TIMEOUT_MS = INTERVAL_MS * 4;

function premiumTimeLeft(u) {
  if (!u.premium || !u.premiumExpireDate) return -1;
  const left = u.premiumExpireDate - Math.floor(Date.now() / 1000);
  return left > 0 ? left : -1;
}

// The client already replies to every Ping with its own PING-id packet
// (visto nei log: `id=25600` in ingresso) - prima veniva scartato come
// pacchetto sconosciuto. Registrata in handlers.js's dispatch map.
function handlePingReply(socket) {
  if (socket.user) socket.user.lastPong = Date.now();
}

// ponytail: no real RTT tracking (the reference's pingOk lock) - just a
// liveness timestamp, enough to catch a connection that never fires the
// socket 'close'/'error' event on its own (cable pulled, NAT silently
// dropped it). Add real RTT if the client ever needs it for something
// beyond display.
function startPingLoop(db) {
  setInterval(() => {
    const now = Date.now();
    for (const u of users.values()) {
      if (now - u.lastPong > PONG_TIMEOUT_MS) {
        u.socket.destroy(); // triggers the existing 'close' handler cleanup (handlers.js)
        continue;
      }
      // Same spot the reference calls UpdatePremiumState() - right before
      // building the Ping packet. Notify-only (per the user's own choice):
      // no forced reconnect, so the 5th-slot display can stay stale until
      // their next natural relogin - same known limit as GM level/money
      // changes (see gm.js).
      if (checkPremiumExpiry(db, u)) {
        u.socket.sendPacket(CHAT, [1, 0, 'GM', NOTICE, 0, 'NULL', 'GM>> Il tuo premium è scaduto.']);
      }
      u.socket.sendPacket(PING, [INTERVAL_MS, 0, 0, -1, 4, GameConfig.expRate, GameConfig.dinarRate, premiumTimeLeft(u)]);
    }
  }, INTERVAL_MS);
}

module.exports = { startPingLoop, handlePingReply, PING };
