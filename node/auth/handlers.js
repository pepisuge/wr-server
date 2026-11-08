const crypto = require('crypto');
const { promisify } = require('util');
const { getAllAuthorized } = require('./server-manager');
const { PORTS } = require('../lib/constants');

const LAUNCHER = 0x1010; // aka LPATCH: client asking "am I on the latest patch?"
const SERVER_LIST = 0x1100; // request = login attempt, reply = server list (or an error code)
const PLAYER_AUTHORIZATION = 0x1300; // internal, Auth -> Game: [sessionId, userId, username, displayname]

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

// The address a game server config.json ships with is meaningless once
// clients connect from more than one network (localhost test, LAN, a VM's
// virtual switch, ...): whatever address the client used to reach *this*
// socket is, by definition, an address that reaches this host - auth and
// game listen on all interfaces of the same machine, so it reaches game too.
function localIp(socket) {
  const addr = socket.localAddress || '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'ascii').digest('hex');
}

// Password storage, no schema change: users.password char(64) holds a 32-byte hash as hex, users.passwordsalt char(10)
// the salt. A salt starting with '$' means scrypt (stdlib); otherwise the upstream SHA-256(password + salt), which is
// upgraded to scrypt on the next successful login.
const scrypt = promisify(crypto.scrypt);

async function hashPassword(password, salt) {
  return salt.startsWith('$') ? (await scrypt(password, salt, 32)).toString('hex') : sha256(password + salt);
}

function newScryptSalt() {
  return '$' + crypto.randomBytes(7).toString('base64url').slice(0, 9); // 54 random bits, fits char(10)
}

function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(String(b).toLowerCase(), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

async function upgradeToScrypt(db, userId, password) {
  const salt = newScryptSalt();
  await db.query('UPDATE users SET password = ?, passwordsalt = ? WHERE id = ?', [await hashPassword(password, salt), salt, userId]);
}

// Same order as the client's version.cfg: Format, Launcher, Updater, Client, Sub, Option.
// Echoing the installed versions (client 22: 0/10/15/22/0/0) = "already up to date" and
// the launcher leaves version.cfg alone; the C# reference sends all 0, which made client 22
// rewrite Updater=0. Request carries no version, so this must match the client you test with.
const PATCH_VERSIONS = [0, 10, 15, 22, 0, 0];

function handleLauncher(socket) {
  // Patch base URL: the address this client used to reach us (works from a VM / LAN, same trick as the game server IP)
  // serving tools/patch-server on port 80; WR_PATCH_URL overrides it.
  socket.sendPacket(LAUNCHER, [...PATCH_VERSIONS, process.env.WR_PATCH_URL || `http://${localIp(socket)}/wr/`]);
  socket.end();
}

function sendLoginError(socket, code) {
  socket.sendPacket(SERVER_LIST, [code]);
  socket.end();
}

// Capped at 15 bits (max 0x7ffe=32766): the client stores/echoes this as a
// *signed* 16-bit int, so anything from 32768-65535 wraps negative when it
// comes back (observed: sent 39574, got back -25962 = 39574-65536).
// Sequential instead of random: random collided (birthday paradox - already
// 46% likely with 200 concurrent logins) and a collision silently overwrote
// another player's entry in game/state.js's `users` map with no error. A
// wrapping counter can't collide until 0x7ffe players are online at once,
// which handleAuthorization's users.has() guard (game/handlers.js) rejects
// with IdInUse same as it already does for a duplicate account.
let nextSessionId = 1;
function allocSessionId() {
  const id = nextSessionId;
  nextSessionId = (nextSessionId % 0x7ffe) + 1;
  return id;
}

// Failed-login throttle per IP: MAX_FAILS wrong user/password within FAIL_WINDOW_MS lock that IP out until the window
// ends. Per IP, not per account, so nobody can lock a victim out of their own account.
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const fails = new Map(); // ip -> { n, since }

function isLockedOut(ip, now = Date.now()) {
  const f = fails.get(ip);
  if (f && now - f.since > FAIL_WINDOW_MS) fails.delete(ip);
  return (fails.get(ip)?.n ?? 0) >= MAX_FAILS;
}

function noteFailedLogin(ip, now = Date.now()) {
  if (fails.size > 10000) for (const [k, f] of fails) if (now - f.since > FAIL_WINDOW_MS) fails.delete(k);
  const f = fails.get(ip) ?? { n: 0, since: now };
  f.n++;
  fails.set(ip, f);
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

    const ip = socket.remoteAddress;
    if (isLockedOut(ip)) return sendLoginError(socket, ERROR_CODES.wrongPassword); // same answer as a wrong password

    const [rows] = await db.query(
      'SELECT id, status, displayname, password, passwordsalt FROM users WHERE username = ?',
      [username]
    );
    if (rows.length === 0) {
      noteFailedLogin(ip);
      return sendLoginError(socket, ERROR_CODES.wrongUser);
    }

    const user = rows[0];
    if (!sameHash(await hashPassword(password, user.passwordsalt), user.password)) {
      noteFailedLogin(ip);
      return sendLoginError(socket, ERROR_CODES.wrongPassword);
    }
    fails.delete(ip);
    if (!user.passwordsalt.startsWith('$')) {
      upgradeToScrypt(db, user.id, password).catch((err) => console.error('login: password hash upgrade failed:', err.message));
    }
    if (user.status <= 0) return sendLoginError(socket, ERROR_CODES.banned);

    const sessionId = allocSessionId();
    const servers = getAllAuthorized();
    // Tell every game server which account owns this session before the client can reach them: game/handlers.js
    // accepts an Authorization only for a session announced here (the client's own userId/sessionId are spoofable).
    for (const s of servers) s.socket.sendPacket(PLAYER_AUTHORIZATION, [sessionId, user.id, username, user.displayname]);

    // Client 22 expects the C# reference's "1.11025 // PF_20" version field here (client 17 didn't).
    const fields = [1, user.id, 0, username, 'NULL', user.displayname, sessionId, 1, 0, user.status, 1.11025, servers.length];
    const gameIp = localIp(socket);
    for (const s of servers) fields.push(s.id, s.name, gameIp, PORTS.game, s.playerCount, s.type);
    fields.push(-1, -1, -1, -1, 0, 0);

    socket.sendPacket(SERVER_LIST, fields);
    socket.end();
  }

  return { [LAUNCHER]: handleLauncher, [SERVER_LIST]: handlePlayerLogin };
}

module.exports = { createHandlers, hashPassword };
