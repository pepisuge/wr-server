const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, lobbyUsersIn, users } = require('./state');
const { handleGmCommand } = require('./gm');

const CHAT = 0x7400;

const TYPE = {
  NOTICE1: 1,
  NOTICE2: 2,
  LOBBY_TO_CHANNEL: 3,
  ROOM_TO_ALL: 4,
  WHISPER: 6,
  LOBBY_TO_ALL: 8,
  CLAN: 10,
};

function broadcast(sockets, fields) {
  if (sockets.length) broadcastPacket(sockets, XOR.external, CHAT, fields);
}

// The client wraps the actual text after a ">>" + 0x1D marker (some prefix
// before that we don't need), and swaps real spaces for 0x1D on the wire so
// they don't get mistaken for field separators - undo both here just to
// validate/log the human-readable text. Ported from Game/Handlers/Chat.cs.
function extractText(rawMessage) {
  const marker = '>>\x1D';
  const idx = rawMessage.indexOf(marker);
  if (idx === -1) return '';
  return rawMessage.slice(idx + marker.length).split('\x1D').join(' ');
}

// Ported from Game/Handlers/Chat.cs. Skips Room_ToTeam (no per-team chat
// scoping yet) and the /cris command branch (Cristina subsystem is out of
// scope) - unrecognized/out-of-scope types are silently ignored.
function handleChat(socket, pkt, db) {
  const u = socket.user;
  if (!u) return;

  const type = Number(pkt.blocks[0]);
  const targetId = Number(pkt.blocks[1]);
  const targetName = pkt.blocks[2] || '';
  const message = pkt.blocks[3] || '';
  const text = extractText(message);

  if (text.startsWith('/cris') || text.length > 60) return;

  // GM commands: only for is_gm accounts, so a non-GM typing "/whatever"
  // just sends it as ordinary chat text instead of being silently eaten.
  if (u.isGm && text.startsWith('/')) return handleGmCommand(socket, db, text);

  const fields = [1, u.sessionId, u.displayname, type, targetId, targetName, message];

  switch (type) {
    case TYPE.LOBBY_TO_CHANNEL: {
      if (u.roomId !== null) return socket.end();
      broadcast(lobbyUsersIn(u.channel, null).map((x) => x.socket), fields);
      break;
    }
    case TYPE.LOBBY_TO_ALL: {
      if (u.roomId !== null) return socket.end();
      broadcast([...users.values()].filter((x) => x.roomId === null).map((x) => x.socket), fields);
      break;
    }
    case TYPE.ROOM_TO_ALL: {
      if (u.roomId === null) return socket.end();
      const room = getChannel(u.channel).rooms.get(u.roomId);
      if (!room) return;
      const sockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
      broadcast(sockets, fields);
      break;
    }
    case TYPE.WHISPER: {
      const target = [...users.values()].find((x) => x.displayname === targetName);
      if (target) {
        socket.sendPacket(CHAT, fields);
        broadcast([target.socket], [1, u.sessionId, u.displayname, type, target.sessionId, target.displayname, message]);
      } else {
        socket.sendPacket(CHAT, [95040, targetName + ' ']);
      }
      break;
    }
    case TYPE.CLAN: {
      if (u.clanId <= 0) return;
      const sockets = [...users.values()].filter((x) => x.clanId === u.clanId).map((x) => x.socket);
      broadcast(sockets, fields);
      break;
    }
    default:
      break;
  }
}

// A server-authored line in the room's chat, not a reply to any incoming
// CHAT packet - used by the autostart countdown (gamesubs.js) since that's
// apparently how this client actually surfaces it (per live domain
// knowledge: a countdown visible in chat). NOTICE1 instead of ROOM_TO_ALL so
// it renders with distinct system styling instead of looking like a normal
// player line - untested against the real client yet, and ping.js's own
// premium-expiry notice comment flags a risk worth watching for: an earlier
// WHISPER mix-up rendered as a popup instead of an inline chat line for a
// different message type, so confirm this one still reads as a chat line
// and not a popup once seen live.
function broadcastSystemMessage(room, text) {
  const sockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
  broadcast(sockets, [1, 0, 'System', TYPE.NOTICE1, 0, 'NULL', text]);
}

module.exports = { handleChat, CHAT, broadcastSystemMessage };
