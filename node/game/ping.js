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

function premiumTimeLeft(u) {
  if (!u.premium || !u.premiumExpireDate) return -1;
  const left = u.premiumExpireDate - Math.floor(Date.now() / 1000);
  return left > 0 ? left : -1;
}

// ponytail: no round-trip tracking (the reference's pingOk lock + client
// reply handler) - just push on a timer. Add real RTT if the client ever
// needs it for something beyond display.
function startPingLoop(db) {
  setInterval(() => {
    for (const u of users.values()) {
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

module.exports = { startPingLoop, PING };
