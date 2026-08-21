const crypto = require('crypto');
const { getAllAuthorized } = require('./server-manager');
const { PORTS } = require('../lib/constants');

const LAUNCHER = 0x1010; // aka LPATCH: client asking "am I on the latest patch?"
const SERVER_LIST = 0x1100; // request = login attempt, reply = server list (or an error code)

const ERROR_CODES = {
  wrongUser: 72010,
  wrongPassword: 72020,
  banned: 73050,
  enterIdError: 74010,
  enterPasswordError: 74020,
};

function isAlphaNumeric(s) {
  return /^[a-zA-Z0-9]+$/.test(s);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'ascii').digest('hex');
}

// Reply with version 0 in every field - since that's always lower than
// whatever version the client actually has, it concludes it's already up to
// date and moves on. Ported as-is from Authorization/Handlers/Launcher.cs +
// Authorization/Packets/Launcher.cs.
function handleLauncher(socket) {
  socket.sendPacket(LAUNCHER, [0, 0, 0, 0, 0, 0, 'http://']);
  socket.end();
}

function sendLoginError(socket, code) {
  socket.sendPacket(SERVER_LIST, [code]);
  socket.end();
}

function createHandlers(db) {
  // Ported from Authorization/Handlers/PlayerLogin.cs + Packets/ServerList.cs.
  // Field indices (blocks[2]=username, blocks[3]=password) come straight
  // from the C# GetString(2)/GetString(3) calls - not yet confirmed against
  // a real capture, adjust if the real client sends something different.
  async function handlePlayerLogin(socket, pkt) {
    const username = pkt.blocks[2] || '';
    const password = pkt.blocks[3] || '';

    if (username.length < 3 || !isAlphaNumeric(username)) return sendLoginError(socket, ERROR_CODES.enterIdError);
    if (password.length < 3) return sendLoginError(socket, ERROR_CODES.enterPasswordError);

    const [rows] = await db.query(
      'SELECT id, status, displayname, password, passwordsalt FROM users WHERE username = ?',
      [username]
    );
    if (rows.length === 0) return sendLoginError(socket, ERROR_CODES.wrongUser);

    const user = rows[0];
    const hashed = sha256(password + user.passwordsalt);
    if (hashed !== user.password.toLowerCase()) return sendLoginError(socket, ERROR_CODES.wrongPassword);
    if (user.status <= 0) return sendLoginError(socket, ERROR_CODES.banned);

    // ponytail: no session bookkeeping yet (no duplicate-login check, no
    // link to the Game server's own auth check) - add when Phase 3 needs it.
    // Capped at 15 bits (max 32767): the client stores/echoes this as a
    // *signed* 16-bit int, so anything from 32768-65535 wraps negative when
    // it comes back (observed: sent 39574, got back -25962 = 39574-65536).
    const sessionId = 1 + Math.floor(Math.random() * 0x7ffe);
    const servers = getAllAuthorized();

    // Note: the C# reference appends a "1.11025 // PF_20" version field here,
    // but this client build (17.2) showed a field-shifted, garbled server
    // list when we included it - dropped until we confirm what this client
    // actually expects at this position.
    const fields = [1, user.id, 0, username, 'NULL', user.displayname, sessionId, 1, 0, user.status, servers.length];
    for (const s of servers) fields.push(s.id, s.name, s.ip, PORTS.game, s.playerCount, s.type);
    fields.push(-1, -1, -1, -1, 0, 0);

    socket.sendPacket(SERVER_LIST, fields);
    socket.end();
  }

  return { [LAUNCHER]: handleLauncher, [SERVER_LIST]: handlePlayerLogin };
}

module.exports = { createHandlers };
