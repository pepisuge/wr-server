const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, lobbyUsersIn, users, roomSockets } = require('./state');
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

// Client 22 (decompiled 0x7400 handler) prints the message field as-is, "Name>> " prefix included, and colours a
// room line by targetId: 999 yellow (system), 997/998 light blue (used here for GMs), anything else white.
const SYSTEM_TARGET = 999;
const GM_TARGET = 998;
const MAX_TEXT = 60; // the client caps typed input at 55
const MAX_NAME = 16; // users.displayname is varchar(16)
const CHAT_BURST = 5; // messages per CHAT_WINDOW_MS, per player
const CHAT_WINDOW_MS = 5000;

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
  const raw = pkt.blocks[3] || '';
  // Every field here is the sender's word. No ">>" marker, an over-long text or target name: not a real client.
  if (!raw.includes('>>\x1D') || targetName.length > MAX_NAME) return;
  const text = extractText(raw);
  if (!text || text.length > MAX_TEXT || text.startsWith('/cris')) return;

  // GM commands: only for is_gm accounts, so a non-GM typing "/whatever"
  // just sends it as ordinary chat text instead of being silently eaten.
  if (u.isGm && text.startsWith('/')) return handleGmCommand(socket, db, text);

  // Muted players are cut off before any TYPE branch runs (so it also blocks
  // whispers/clan chat, not just room/lobby) - GM commands above already
  // returned by this point, so a muted GM can still run /unmute on themself.
  if (u.mutedexpire > Math.floor(Date.now() / 1000)) {
    const minutesLeft = Math.ceil((u.mutedexpire - Date.now() / 1000) / 60);
    socket.sendPacket(CHAT, [1, 0, 'System', TYPE.WHISPER, u.sessionId, u.displayname, `System>> Sei silenziato ancora per ${minutesLeft} minuti.`]);
    return;
  }

  const now = Date.now();
  u.chatTimes = (u.chatTimes ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
  if (u.chatTimes.length >= CHAT_BURST) return sendSystemWhisper(socket, 'Slow down: too many messages.');
  u.chatTimes.push(now);

  // The prefix is rebuilt from the real nickname, so nobody can post as "System", a GM or another player.
  const message = `${u.displayname}>> ${text}`;
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
      if (u.isGm) fields[4] = GM_TARGET; // light blue for staff (outside a match; in-game lines use team colours)
      broadcast(roomSockets(room), fields);
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
// CHAT packet - used by the autostart countdown (gamesubs.js). Tried NOTICE1
// (targetId=999, ">>" prefix, matching every real Notice1 use in both
// references) hoping for distinct system styling - live test showed it
// renders as a popup instead, once per second, unusable for a countdown.
// Back to ROOM_TO_ALL, the type confirmed to render as an ordinary chat line
// (same color as a normal player message - a real but lesser problem than a
// popup spamming every tick). Kept the "System>> " prefix since it doesn't
// hurt and matches the same "name>> text" shape every other message uses.
function broadcastSystemMessage(room, text) {
  const sockets = roomSockets(room);
  broadcast(sockets, [1, 0, 'System', TYPE.ROOM_TO_ALL, SYSTEM_TARGET, 'NULL', `System>> ${text}`]);
}

// Server-wide notice. In the lobby the client shows type 1/2 as a notice popup (reference: Notice2, ">>" + text,
// sent to lobbies only); players inside a room don't get that window, so they get a yellow system line instead.
function sendNotice(text) {
  const all = [...users.values()];
  broadcast(all.filter((x) => x.roomId === null).map((x) => x.socket), [1, 0, 'Notice', TYPE.NOTICE2, SYSTEM_TARGET, 'NULL', `>> ${text}`]);
  broadcast(all.filter((x) => x.roomId !== null).map((x) => x.socket), [1, 0, 'Notice', TYPE.ROOM_TO_ALL, SYSTEM_TARGET, 'NULL', `Notice>> ${text}`]);
}

// A server-authored whisper to just one socket - same wire shape as a real
// WHISPER, sender name "SYSTEM". Used by clan.js for the errors ToXiiC's
// reference sends this way instead of a CLAN_SYSTEM reply (name taken, not
// enough dinar, not the master, ...).
function sendSystemWhisper(socket, text) {
  const u = socket.user;
  socket.sendPacket(CHAT, [1, 0, 'SYSTEM', TYPE.WHISPER, u.sessionId, u.displayname, `SYSTEM>> ${text}`]);
}

// A server-authored line in a clan's own chat (disband/promote notices) -
// same TYPE.CLAN shape a real member message uses, just authored by
// "ClanSystem". Mirrors broadcastSystemMessage's role for room chat.
function sendClanNotice(clanId, text) {
  const sockets = [...users.values()].filter((x) => x.clanId === clanId).map((x) => x.socket);
  broadcast(sockets, [1, 0, 'ClanSystem', TYPE.CLAN, clanId, 'NULL', `ClanSystem>> ${text}`]);
}

module.exports = { handleChat, CHAT, broadcastSystemMessage, sendSystemWhisper, sendClanNotice, sendNotice };
