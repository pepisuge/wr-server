const net = require('net');
const { wrapSocket } = require('../lib/xor-socket');
const { PORTS, XOR } = require('../lib/constants');
const { DEBUG } = require('../lib/log');

const CONNECTION = 0x1200; // greeting the Auth server sends right on accept
const AUTHORIZATION = 0x1000;
const PLAYER_AUTHORIZATION = 0x1300;
// Single-use: client 22 goes back through Auth (new session) on every reconnect, verified live.
const SESSION_TTL_MS = 10 * 60 * 1000; // login -> game connect takes seconds

// sessionId -> { userId, username, displayname, at }: logins announced by Auth, consumed by game/handlers.js.
const pendingSessions = new Map();

// Website sign-on tokens from the same push: token -> { userId, username, displayname, at }. One per account (a new
// login replaces it), reusable until then so the CLAN button works on every click; read by game/web.js.
const WEB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const webTokens = new Map();

function webTokenUser(token) {
  const t = webTokens.get(token);
  return t && Date.now() - t.at < WEB_TOKEN_TTL_MS ? t : null;
}

function addWebToken(token, user) {
  if (!/^[0-9a-f]{32}$/.test(token || '')) return;
  for (const [k, v] of webTokens) if (v.userId === user.userId || Date.now() - v.at > WEB_TOKEN_TTL_MS) webTokens.delete(k);
  webTokens.set(token, { ...user, at: Date.now() });
}

function takeSession(sessionId, userId, username) {
  const s = pendingSessions.get(sessionId);
  if (!s || s.userId !== userId || s.username.toLowerCase() !== username.toLowerCase() || Date.now() - s.at > SESSION_TTL_MS) return null;
  pendingSessions.delete(sessionId);
  return s;
}

// Registers this Game server with the Auth server over the internal channel.
// Ported from Game/Networking/ServerClient.cs + Game/Handlers/Internal/{Connection,Authorization}.cs:
// connect -> wait for the greeting -> send our registration -> wait for the "you're server #N" reply.
function connectToAuthServer(config) {
  const socket = net.connect(PORTS.internal, config.authServerIp, () => {
    console.log('Internal: connected to Auth server');
  });

  wrapSocket(socket, XOR.internalGame, (pkt) => {
    if (DEBUG) console.log(`Internal IN tick=${pkt.tick} id=${pkt.id} blocks=[${pkt.blocks.join(', ')}]`);

    if (pkt.id === CONNECTION) {
      socket.sendPacket(AUTHORIZATION, [1, config.serverKey, `${config.serverName} `, config.serverIp, PORTS.game, Number(process.env.WR_SERVER_TYPE) || 0]); // WR_SERVER_TYPE=65..70: client 22 "A..F" channel UI (test)
    } else if (pkt.id === PLAYER_AUTHORIZATION) {
      const [sessionId, userId, username, displayname, webToken] = pkt.blocks;
      const now = Date.now();
      for (const [id, s] of pendingSessions) if (now - s.at > SESSION_TTL_MS) pendingSessions.delete(id);
      pendingSessions.set(Number(sessionId), { userId: Number(userId), username, displayname, at: now });
      addWebToken(webToken, { userId: Number(userId), username, displayname });
    } else if (pkt.id === AUTHORIZATION) {
      const [errorCode, serverId] = pkt.blocks;
      if (Number(errorCode) === 1) {
        console.log(`Internal: authorized as server #${serverId}`);
      } else {
        console.log(`Internal: authorization failed, error code ${errorCode}`);
      }
    }
  });

  socket.on('error', (err) => console.log(`Internal: socket error: ${err.message}`));
  socket.on('close', () => {
    console.log('Internal: disconnected from Auth server, retrying in 3s');
    setTimeout(() => connectToAuthServer(config), 3000); // auth restarts must not need a game restart
  });

  return socket;
}

module.exports = { connectToAuthServer, takeSession, pendingSessions, webTokenUser, addWebToken };
