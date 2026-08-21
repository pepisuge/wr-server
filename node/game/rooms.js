const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, lobbyUsersIn, nextFreeRoomId, users } = require('./state');
const { stopRoundTimer } = require('./roundtimer');
const { levelForXp, suitableLevel, applyMatchEnd } = require('./progression');
const { clanInfo } = require('./clan');

const ROOM_CREATION = 0x7300;
const ROOM_JOIN = 0x7310;
const ROOM_LEAVE = 0x7340;
const ROOM_LIST_UPDATE = 0x7210;
const ROOM_LIST = 0x7200;
const PLAYER_INFO = 0x7500;
const LEVEL_UP = 0x7920;

// Max players per "slider index" the client sends, by channel - lifted
// straight from Game/Entities/Room.cs. CQC uses a formula instead of a
// lookup table in the original; everything else is a fixed array.
const URBAN_MAX_PLAYERS = [8, 16, 20, 24];
const BATTLE_MAX_PLAYERS = [8, 16, 20, 24, 32];

function maxPlayersFor(channel, index) {
  if (channel === 1) return 8 * (index + 1); // CQC
  if (channel === 2) return URBAN_MAX_PLAYERS[index] ?? 8;
  if (channel === 3) return BATTLE_MAX_PLAYERS[index] ?? 8;
  return 8;
}

// The 25-field room description block shared by RoomCreation, RoomJoin,
// RoomList and RoomUpdate (Game/Packets/*.cs all have an identical
// addRoomInfo). ponytail: no teams/slots/clan war/game modes yet - those only
// matter once actual matches are in scope, well past this phase.
function roomInfoFields(room) {
  return [
    room.id,
    1,
    room.state, // 1 = Waiting, 2 = Playing
    room.master,
    room.name,
    room.hasPassword ? 1 : 0,
    room.maxPlayers,
    room.players.size,
    room.map,
    room.mode === 0 ? room.setting : 0,
    room.mode > 0 ? room.setting : 0,
    0,
    room.mode,
    4,
    room.players.size < room.maxPlayers ? 1 : 0, // joinable
    0,
    room.supermaster ? 1 : 0,
    room.type,
    room.levelLimit,
    room.friendlyFire ? 1 : 0,
    room.enableVoteKick ? 1 : 0,
    room.autoStart ? 1 : 0,
    0,
    room.pingLimit,
    room.isClanWar,
  ];
}

// The per-player roster block (Game/Packets/RoomPlayers.cs) - what tells the
// client who else is in the room and lets it render team/ready state.
// ponytail: weapon/class/health/kills/deaths/xp/IP:port are all placeholders
// (0, or "not connected") - we don't track loadouts, stats, or the UDP
// endpoint per player yet. Good enough for the roster to *exist*; anything
// depending on real values (damage, voice/hit-reg by IP) is a later phase.
function roomPlayerFields(player) {
  const u = users.get(player.sessionId);
  const clan = u ? clanInfo(u) : null;
  return [
    player.userId,
    player.sessionId,
    player.slot,
    player.ready ? 1 : 0,
    player.team,
    0, // weapon
    0,
    0, // class
    100, // health
    player.displayname,
    ...(clan ? [clan.id, clan.name, clan.rank] : [-1, -1, -1]),
    1,
    0,
    910,
    u ? u.premium : 0,
    -1,
    0, // kills
    0, // deaths
    0,
    u ? u.xp : 0,
    -1,
    -1,
    0, 0, 0, 0, // remote/local ip:port - not tracked
    0,
  ];
}

function sendRoomPlayers(sockets, players) {
  if (!sockets.length) return;
  const fields = [players.length];
  for (const p of players) fields.push(...roomPlayerFields(p));
  broadcastPacket(sockets, XOR.external, PLAYER_INFO, fields);
}

// Team is encoded in the slot number, not a separate concept the client
// tracks independently: the low half of a room's slots (0..half) is team 0,
// the high half is team 1 (Game/Entities/Room.cs' SwitchSide scans exactly
// these ranges). Assigning a slot from the wrong half is what silently
// desynced the client's own team display from what we thought it was.
function findFreeSlot(room, team, excludePlayer) {
  const half = Math.floor(room.maxPlayers / 2);
  const start = team === 1 ? half : 0;
  const end = team === 1 ? room.maxPlayers : half;
  const used = new Set([...room.players.values()].filter((p) => p !== excludePlayer).map((p) => p.slot));
  for (let i = start; i < end; i++) if (!used.has(i)) return i;
  return null;
}

function sendRoomUpdateToLobby(room, isUpdate) {
  const sockets = lobbyUsersIn(room.channel, null).map((u) => u.socket);
  if (sockets.length) broadcastPacket(sockets, XOR.external, ROOM_LIST_UPDATE, [room.id, isUpdate ? 1 : 0, ...roomInfoFields(room)]);
}

function sendRoomDeleteToLobby(channel, roomId) {
  const sockets = lobbyUsersIn(channel, null).map((u) => u.socket);
  if (sockets.length) broadcastPacket(sockets, XOR.external, ROOM_LIST_UPDATE, [roomId, 2]); // RoomUpdateType: 0=Create,1=Update,2=Delete
}

// Ported from Game/Handlers/RoomCreation.cs. Skips level/clan/inventory
// gating (we don't track XP or items yet) and vote-kick's CC02 item check.
function handleRoomCreation(socket, pkt) {
  const u = socket.user;
  if (!u || u.roomId !== null) {
    socket.end();
    return;
  }

  const name = pkt.blocks[0] || '';
  const hasPassword = Number(pkt.blocks[1]) > 0;
  const password = pkt.blocks[2] || '';
  const maxPlayersIndex = Number(pkt.blocks[3]) || 0;
  const type = Number(pkt.blocks[7]) || 0;
  const levelLimit = Number(pkt.blocks[8]) || 0;
  const friendlyFire = Number(pkt.blocks[9]) > 0;
  const enableVoteKick = Number(pkt.blocks[10]) > 0;

  const valid =
    name.length > 0 &&
    name.length <= 25 &&
    !(hasPassword && (password.length === 0 || password === 'NULL')) &&
    suitableLevel(levelLimit, levelForXp(u.xp));
  if (!valid) {
    socket.sendPacket(ROOM_CREATION, [92010]); // GenericError
    return;
  }

  const chan = getChannel(u.channel);
  const id = nextFreeRoomId(chan);
  const room = {
    id,
    channel: u.channel,
    name,
    hasPassword,
    password: hasPassword ? password : 'NULL',
    maxPlayers: maxPlayersFor(u.channel, maxPlayersIndex),
    map: 1,
    mode: 2, // Team_Death_Match placeholder - real map/mode rotation is a later phase
    setting: 2,
    state: 1, // Waiting
    type,
    levelLimit,
    friendlyFire,
    enableVoteKick,
    autoStart: false,
    pingLimit: 2,
    isClanWar: -1,
    supermaster: false,
    master: 0, // slot index, not a sessionId
    players: new Map([
      [u.sessionId, { sessionId: u.sessionId, userId: u.id, displayname: u.displayname, slot: 0, team: 0, ready: true }],
    ]),
  };
  chan.rooms.set(id, room);
  u.roomId = id;

  socket.sendPacket(ROOM_CREATION, [1, 0, ...roomInfoFields(room)]);
  sendRoomUpdateToLobby(room, false);
}

// Invoked from clan.js's START_WAR - no client packet triggers this, the
// reference never actually wires up isClanWar=true anywhere (see the
// guide), so there's no RoomCreation request to read fields from. Reuses
// the same room shape/broadcast as a normal creation so the rest of
// rooms.js (join/leave/roster) treats it identically to any other room.
function createClanWarRoom(challenger, opponentClanId) {
  const chan = getChannel(challenger.channel);
  const id = nextFreeRoomId(chan);
  const room = {
    id,
    channel: challenger.channel,
    name: `Clan War #${id}`,
    hasPassword: false,
    password: 'NULL',
    maxPlayers: maxPlayersFor(challenger.channel, 1),
    map: 1,
    mode: 2,
    setting: 2,
    state: 1, // Waiting
    type: 0,
    levelLimit: 0,
    friendlyFire: true,
    enableVoteKick: false,
    autoStart: false,
    pingLimit: 2,
    isClanWar: 1, // wire convention from Packets/RoomCreation.cs etc: -1 = no, >0 = yes
    clan1: challenger.clanId,
    clan2: opponentClanId,
    supermaster: false,
    master: 0,
    players: new Map([
      [
        challenger.sessionId,
        { sessionId: challenger.sessionId, userId: challenger.id, displayname: challenger.displayname, slot: 0, team: 0, ready: true },
      ],
    ]),
  };
  chan.rooms.set(id, room);
  challenger.roomId = id;

  challenger.socket.sendPacket(ROOM_CREATION, [1, 0, ...roomInfoFields(room)]);
  sendRoomUpdateToLobby(room, false);
  return room;
}

// Ported from Game/Handlers/RoomJoin.cs + Room.Add. Skips level-limit gating.
function handleRoomJoin(socket, pkt) {
  const u = socket.user;
  if (!u || u.roomId !== null) return;

  const roomId = Number(pkt.blocks[0]);
  const password = pkt.blocks[1] || '';
  const chan = getChannel(u.channel);
  const room = chan.rooms.get(roomId);

  if (!room) {
    socket.sendPacket(ROOM_JOIN, [94010]); // GenericError
    return;
  }
  if (room.hasPassword && room.password !== password) {
    socket.sendPacket(ROOM_JOIN, [94030]); // InvalidPassword
    return;
  }
  if (!suitableLevel(room.levelLimit, levelForXp(u.xp))) {
    socket.sendPacket(ROOM_JOIN, [94300]); // BadLevel
    return;
  }
  if (room.players.size >= room.maxPlayers) {
    socket.sendPacket(ROOM_JOIN, [94120]); // RoomIsFull
    return;
  }

  let team;
  if (room.isClanWar > 0) {
    // Clan war: team follows which of the two clans you belong to, not the
    // usual auto-balance - joining a war you're not part of is rejected
    // outright, same generic error other join rejections already use.
    if (u.clanId !== room.clan1 && u.clanId !== room.clan2) {
      socket.sendPacket(ROOM_JOIN, [94010]); // GenericError
      return;
    }
    team = u.clanId === room.clan1 ? 0 : 1;
  } else {
    const debCount = [...room.players.values()].filter((p) => p.team === 0).length;
    const niuCount = [...room.players.values()].filter((p) => p.team === 1).length;
    team = debCount > niuCount ? 1 : 0;
  }
  const slot = findFreeSlot(room, team, null);
  if (slot === null) {
    socket.sendPacket(ROOM_JOIN, [94120]); // RoomIsFull (that team's half is full)
    return;
  }
  const newPlayer = { sessionId: u.sessionId, userId: u.id, displayname: u.displayname, slot, team, ready: false };

  // Tell the players already there about the newcomer, before adding them
  // to the room (matches Room.Add: broadcasts first, then registers).
  const existingSockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
  sendRoomPlayers(existingSockets, [newPlayer]);

  room.players.set(u.sessionId, newPlayer);
  u.roomId = room.id;

  socket.sendPacket(ROOM_JOIN, [1, slot, ...roomInfoFields(room)]);
  const others = [...room.players.values()].filter((p) => p.sessionId !== u.sessionId);
  sendRoomPlayers([socket], others);
  sendRoomUpdateToLobby(room, true);
}

// Shared by handleRoomLeave (explicit ROOM_LEAVE packet) and the socket
// 'close' handler (handlers.js) - a dropped connection (crash, closed
// client, no explicit leave) must clean up the room the same way an
// explicit leave does, otherwise the player becomes a permanent "ghost"
// still occupying a slot under a session that no longer resolves to any
// socket (found via clan war testing: reconnecting mid-test without ever
// leaving left duplicate stale entries in the room roster). Also the
// closest thing this server has to "a match ended" for the leaving player
// (see progression.js's applyMatchEnd) - there's no real round/win-condition
// system yet, so a mid/post-match room leave is the trigger, not a proper
// round-end broadcast. Returns the room left (or null if not in one).
function removeFromRoom(db, u) {
  if (!u || u.roomId === null) return null;

  const chan = getChannel(u.channel);
  const room = chan.rooms.get(u.roomId);
  if (!room) {
    u.roomId = null;
    return null;
  }

  const player = room.players.get(u.sessionId);
  if (room.state === 2 && player) {
    const { levelUp } = applyMatchEnd(db, u);
    if (levelUp) u.socket.sendPacket(LEVEL_UP, [player.slot, 0, levelUp.newLevel, u.xp, levelUp.bonusMoney]);
  }

  room.players.delete(u.sessionId);
  u.roomId = null;

  if (room.players.size === 0) {
    stopRoundTimer(room);
    chan.rooms.delete(room.id);
    sendRoomDeleteToLobby(room.channel, room.id);
  } else {
    room.master = 0; // ponytail: no real slot tracking, master stays "slot 0"
    sendRoomUpdateToLobby(room, true);
  }

  return room;
}

// Ported from Game/Handlers/RoomLeave.cs + Room.Remove/Destroy.
function handleRoomLeave(socket, db) {
  const u = socket.user;
  const wasInRoom = u && u.roomId !== null;
  const room = removeFromRoom(db, u);
  if (!wasInRoom) return;
  socket.sendPacket(ROOM_LEAVE, [1, u.sessionId, 0, room ? room.players.size : 0, room ? room.master : 0, 0, 0]);
}

// Ported from Game/Handlers/ChangeChannel.cs' RoomList half.
function sendRoomList(socket, page) {
  const u = socket.user;
  const chan = getChannel(u.channel);
  const rooms = [...chan.rooms.values()].filter((r) => Math.floor((r.id - 1) / 8) === page);
  const fields = [rooms.length, page, 0];
  for (const r of rooms) fields.push(...roomInfoFields(r));
  socket.sendPacket(ROOM_LIST, fields);
}

module.exports = {
  handleRoomCreation,
  handleRoomJoin,
  handleRoomLeave,
  sendRoomList,
  sendRoomUpdateToLobby,
  findFreeSlot,
  createClanWarRoom,
  removeFromRoom,
  ROOM_CREATION,
  ROOM_JOIN,
  ROOM_LEAVE,
};
