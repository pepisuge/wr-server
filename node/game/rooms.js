const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, lobbyUsersIn, nextFreeRoomId, users } = require('./state');
const { stopRoundTimer, endRound } = require('./roundtimer');
const { levelForXp, suitableLevel, applyMatchEnd } = require('./progression');
const { clanInfo } = require('./clan');

const ROOM_CREATION = 0x7300;
const ROOM_JOIN = 0x7310;
const ROOM_LEAVE = 0x7340;
const ROOM_KICK = 0x7341;
const ROOM_INVITE = 0x7350;
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
// ponytail: class/IP:port are still placeholders (0, or "not connected") -
// we don't track player class or the UDP endpoint per player yet.
// health/kills/deaths/weapon are real now (see gamesubs.js's PlayerDamage/
// WeaponSwitch).
function roomPlayerFields(player) {
  const u = users.get(player.sessionId);
  const clan = u ? clanInfo(u) : null;
  return [
    player.userId,
    player.sessionId,
    player.slot,
    player.ready ? 1 : 0,
    player.team,
    player.weapon ?? 0,
    0,
    0, // class
    player.health ?? 100,
    player.displayname,
    ...(clan ? [clan.id, clan.name, clan.rank] : [-1, -1, -1]),
    1,
    0,
    910,
    u ? u.premium : 0,
    -1,
    player.kills ?? 0,
    player.deaths ?? 0,
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
    // ponytail: was 2 (5 rounds via explosive.js's ROUND_LIMITS) - real capture
    // shows the client never sends CHANGE_ROUNDS/CHANGE_KILLS (53/55) for an
    // Explosive room left untouched, yet its UI shows "single round" right
    // away. 0 matches that (ROUND_LIMITS[0]=1) without regressing TDM, whose
    // own default was equally unverified.
    setting: 0,
    state: 1, // Waiting
    type,
    levelLimit,
    friendlyFire,
    enableVoteKick,
    autoStart: false,
    pingLimit: 2,
    userLimit: false, // host-toggled room lock (GameSubs.Userlimit) - separate from maxPlayers
    isClanWar: -1,
    supermaster: false,
    master: 0, // slot index, not a sessionId
    players: new Map([
      [
        u.sessionId,
        {
          sessionId: u.sessionId,
          userId: u.id,
          displayname: u.displayname,
          slot: 0,
          team: 0,
          ready: true,
          health: 100,
          alive: true,
          kills: 0,
          deaths: 0,
          inLobby: true,
        },
      ],
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
    setting: 0, // see normal room creation above for why
    state: 1, // Waiting
    type: 0,
    levelLimit: 0,
    friendlyFire: true,
    enableVoteKick: false,
    autoStart: false,
    pingLimit: 2,
    userLimit: false,
    isClanWar: 1, // wire convention from Packets/RoomCreation.cs etc: -1 = no, >0 = yes
    clan1: challenger.clanId,
    clan2: opponentClanId,
    supermaster: false,
    master: 0,
    players: new Map([
      [
        challenger.sessionId,
        {
          sessionId: challenger.sessionId,
          userId: challenger.id,
          displayname: challenger.displayname,
          slot: 0,
          team: 0,
          ready: true,
          health: 100,
          alive: true,
          kills: 0,
          deaths: 0,
          inLobby: true,
        },
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
  if (room.userLimit) {
    socket.sendPacket(ROOM_JOIN, [94060]); // UsersExceeded (host locked the room)
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
  const newPlayer = {
    sessionId: u.sessionId,
    userId: u.id,
    displayname: u.displayname,
    slot,
    team,
    ready: false,
    health: 100,
    alive: true,
    kills: 0,
    deaths: 0,
    inLobby: true,
  };

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
// leaving left duplicate stale entries in the room roster). Also pays out
// the leaving player's match-end reward (see progression.js's applyMatchEnd)
// - if they're the second-to-last player standing, endRound() (below) pays
// everyone else and declares a winner; if only they quietly leave a
// still-full room, this is the only reward that happens for them.
// Returns the room left (or null if not in one).
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
    const { levelUp } = applyMatchEnd(db, u, player.kills);
    if (levelUp) u.socket.sendPacket(LEVEL_UP, [player.slot, 0, levelUp.newLevel, u.xp, levelUp.bonusMoney]);
  }

  const wasPlaying = room.state === 2;
  const oldSlot = player?.slot ?? 0;
  room.players.delete(u.sessionId);
  u.roomId = null;

  if (room.players.size === 0) {
    stopRoundTimer(room);
    chan.rooms.delete(room.id);
    sendRoomDeleteToLobby(room.channel, room.id);
  } else if (wasPlaying && room.players.size === 1) {
    endRound(room, db); // last one standing wins
    room.master = 0;
    sendRoomUpdateToLobby(room, true);
  } else {
    room.master = 0; // ponytail: no real slot tracking, master stays "slot 0"
    sendRoomUpdateToLobby(room, true);
  }

  // Ported from Room.Remove/Destroy's `Send(pBuffer); u.Send(pBuffer);` -
  // remaining players' own roster never drops someone who left unless they
  // get this broadcast too, not just the lobby update above. Lives here
  // (not in handleRoomLeave) so a dropped connection (crash, socket 'close'
  // in handlers.js) gets it exactly like an explicit leave does - it used to
  // only fire for the explicit RoomLeave packet, leaving a "ghost" player
  // for anyone whose room-mate crashed instead of leaving normally.
  if (room.players.size > 0) {
    const fields = [1, u.sessionId, oldSlot, room.players.size, room.master, u.xp, u.money];
    const sockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
    broadcastPacket(sockets, XOR.external, ROOM_LEAVE, fields);
  }

  return room;
}

// Ported from Game/Handlers/RoomLeave.cs + Packets/RoomLeave.cs. The
// broadcast to remaining room members (Room.Remove's second Send) now lives
// in removeFromRoom itself, shared with the disconnect path - this only
// still owns the reply to the leaver's own socket.
function handleRoomLeave(socket, db) {
  const u = socket.user;
  if (!u || u.roomId === null) return;

  const chan = getChannel(u.channel);
  const oldSlot = chan.rooms.get(u.roomId)?.players.get(u.sessionId)?.slot ?? 0;

  const room = removeFromRoom(db, u);
  const fields = [1, u.sessionId, oldSlot, room ? room.players.size : 0, room ? room.master : 0, u.xp, u.money];
  socket.sendPacket(ROOM_LEAVE, fields);
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

// Ported from Game/Handlers/RoomList.cs - the client re-requests this on its
// own (refresh, page arrows), separate from the one push sendRoomList()
// already does right after ChannelSelection. Only answered while not in a
// room (matches the reference's `if (u.Room == null)` guard) - a room
// member's view is kept in sync by sendRoomUpdateToLobby's broadcasts
// instead, not by re-answering this request.
function handleRoomListRequest(socket, pkt) {
  const u = socket.user;
  if (!u || u.roomId !== null) return;

  const direction = (Number(pkt.blocks[0]) || 0) - (Number(pkt.blocks[2]) || 0);
  const waitingOnly = Number(pkt.blocks[1]) > 0;
  const page = u.roomListPage || 0;

  if (direction === -1) u.roomListPage = Math.max(0, page - 1);
  else if (direction === 1) u.roomListPage = page + 1;

  const chan = getChannel(u.channel);
  let rooms = [...chan.rooms.values()];
  if (waitingOnly) {
    rooms = rooms
      .filter((r) => r.state === 1)
      .sort((a, b) => b.id - a.id)
      .slice(0, 8)
      .sort((a, b) => a.id - b.id);
  } else {
    const p = u.roomListPage || 0;
    rooms = rooms.filter((r) => r.id >= 8 * p && r.id < 8 * (p + 1)).sort((a, b) => a.id - b.id);
  }

  const fields = [rooms.length, u.roomListPage || 0, 0];
  for (const r of rooms) fields.push(...roomInfoFields(r));
  socket.sendPacket(ROOM_LIST, fields);
}

// Ported from Game/Handlers/RoomKick.cs's wire format and host-only check
// (Room.Master == Player.Id, i.e. the same "master = slot" convention
// removeFromRoom's comment already flags as the only host tracking this
// codebase has). The reference's own KickPlayer only sends the notice and
// never touches server-side room state (no Players.TryRemove, no Master
// reassignment, no lobby update) - that half is a stub, not something to
// copy, so the actual removal below reuses removeFromRoom instead: the same
// function an explicit leave or a dropped connection already goes through.
function handleRoomKick(socket, pkt, db) {
  const u = socket.user;
  if (!u || u.roomId === null) return;

  const chan = getChannel(u.channel);
  const room = chan.rooms.get(u.roomId);
  const kicker = room?.players.get(u.sessionId);
  if (!room || !kicker || kicker.slot !== room.master) return;

  const targetSlot = Number(pkt.blocks[0]);
  const target = [...room.players.values()].find((p) => p.slot === targetSlot);
  if (!target) return;

  const targetUser = users.get(target.sessionId);
  if (!targetUser) return;

  targetUser.socket.sendPacket(ROOM_KICK, [1, targetSlot]);
  removeFromRoom(db, targetUser);
}

const ROOM_INVITE_ERR = { INVITED: 93010, GENERIC: 93020, IN_ROOM: 93030 };

// The 19-field invite payload sent to the target, field order lifted from
// Packets/RoomInvite.cs: [1, 0, -1, sessionId, sessionId (again - "Ping ?!"
// per the reference's own comment), displayname, 4 clan fields, 1, 18, xp,
// 3, 0, -1, message, roomId, roomPassword]. Room id/password ride along in
// plaintext so the invited client can auto-fill them for a follow-up
// RoomJoin - there's no separate accept/invite-tracking handshake.
function inviteFields(inviter, message, room) {
  const clan = clanInfo(inviter);
  return [
    1, 0, -1,
    inviter.sessionId, inviter.sessionId,
    inviter.displayname,
    ...(clan ? [clan.id, clan.name, clan.rank, clan.rank] : [-1, -1, -1, -1]),
    1, 18, inviter.xp, 3, 0, -1,
    message,
    room.id,
    room.password,
  ];
}

// Ported from Game/Handlers/RoomInvite.cs. A target displayname that matches
// no online user gets no reply at all - that's the reference's real
// behavior (its try/catch only guards actual parse exceptions, never a
// missing user), kept as-is rather than "fixed" into a friendlier error.
// The room-full case in the reference only sends a system chat line
// (Cristina.Chat.SayToPlayer) with no dedicated packet - skipped here
// silently rather than wiring a chat helper for one message.
function handleRoomInvite(socket, pkt) {
  const u = socket.user;
  if (!u || u.roomId === null) return;

  const chan = getChannel(u.channel);
  const room = chan.rooms.get(u.roomId);
  if (!room || room.state !== 1 || room.players.size >= room.maxPlayers) return;

  const target = pkt.blocks[0] || '';
  const message = pkt.blocks[1] || '';

  if (target === 'NULL') {
    const candidates = lobbyUsersIn(u.channel, u.sessionId);
    if (candidates.length === 0) {
      socket.sendPacket(ROOM_INVITE, [ROOM_INVITE_ERR.GENERIC]);
      return;
    }
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    socket.sendPacket(ROOM_INVITE, [ROOM_INVITE_ERR.INVITED]);
    picked.socket.sendPacket(ROOM_INVITE, inviteFields(u, message, room));
    return;
  }

  for (const other of users.values()) {
    if (other.displayname !== target) continue;
    if (other.roomId !== null) socket.sendPacket(ROOM_INVITE, [ROOM_INVITE_ERR.IN_ROOM]);
    else if (other.channel === u.channel) other.socket.sendPacket(ROOM_INVITE, inviteFields(u, message, room));
  }
}

module.exports = {
  handleRoomCreation,
  handleRoomJoin,
  handleRoomLeave,
  handleRoomListRequest,
  handleRoomKick,
  handleRoomInvite,
  sendRoomList,
  sendRoomUpdateToLobby,
  sendRoomPlayers,
  findFreeSlot,
  createClanWarRoom,
  removeFromRoom,
  ROOM_CREATION,
  ROOM_JOIN,
  ROOM_LEAVE,
  ROOM_KICK,
  ROOM_INVITE,
  ROOM_LIST,
};
