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

  // roomId=0 is what the real client sends when accepting an invite from its
  // popup (found via a live marker test - it never echoes back the real room
  // id/password we send in the invite payload for this field, always 0) -
  // it's a fixed client-side value for that action, not the real room. Room
  // ids are 0-based here (matching both C# references), so 0 can also be a
  // real room now - try it literally first (a direct click on room 0 in the
  // list must still work), and only fall back to whichever room
  // handleRoomInvite last remembered inviting this user to (u.pendingInviteRoomId)
  // if room 0 doesn't actually exist. Still ambiguous in the narrow case
  // where room 0 is genuinely occupied at the same time as a pending invite
  // to a different room - unresolved without a live test telling the two
  // apart some other way.
  let roomId = Number(pkt.blocks[0]);
  const password = pkt.blocks[1] || '';
  const chan = getChannel(u.channel);
  let room = chan.rooms.get(roomId);
  if (!room && roomId === 0 && u.pendingInviteRoomId) {
    roomId = u.pendingInviteRoomId;
    room = chan.rooms.get(roomId);
  }

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

// Ported from Room.Remove's master-reassignment block: only runs when the
// player who just left WAS the master (callers check that). Priority is
// 1+Premium per occupied slot, scanned in slot order 0..maxPlayers-1 so a
// tie (no premium anywhere) goes to the lowest slot - same tie-break the
// reference gets for free from its own `>` (not `>=`) comparison. Also
// drops Supermaster, matching Room.Remove's "Remove the suppermaster buff".
function reassignMaster(room) {
  room.supermaster = false;
  const bySlot = new Map([...room.players.values()].map((p) => [p.slot, p]));
  let newMaster = null;
  let bestPriority = 0;
  for (let slot = 0; slot < room.maxPlayers; slot++) {
    const p = bySlot.get(slot);
    if (!p) continue;
    const pu = users.get(p.sessionId);
    const priority = 1 + (pu ? pu.premium : 0);
    if (priority > bestPriority) {
      bestPriority = priority;
      newMaster = p;
    }
  }
  if (newMaster) {
    room.master = newMaster.slot;
    newMaster.ready = true; // Room.Remove: `Players[Master].Ready = true`
  }
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
// Does NOT notify the lobby itself (see notifyLobbyAfterLeave) - a real
// client that left a room stopped reacting to lobby room-list updates that
// arrived before its own RoomLeave reply, matching Room.Remove/Destroy's own
// packet order (member broadcast, then reply to the leaver, then - only
// after that, back in the RoomLeave *handler* - the lobby update). Callers
// own sequencing their own reply between this and notifyLobbyAfterLeave.
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
  const wasMaster = oldSlot === room.master;
  room.players.delete(u.sessionId);
  u.roomId = null;

  if (room.players.size === 0) {
    stopRoundTimer(room);
    chan.rooms.delete(room.id);
  } else {
    if (wasMaster) reassignMaster(room);
    if (wasPlaying && room.players.size === 1) endRound(room, db); // last one standing wins
  }

  // Ported from Room.Remove/Destroy's `Send(pBuffer); u.Send(pBuffer);` -
  // remaining players' own roster never drops someone who left unless they
  // get this broadcast too, not just the lobby update. Lives here (not in
  // handleRoomLeave) so a dropped connection (crash, socket 'close' in
  // handlers.js) gets it exactly like an explicit leave does - it used to
  // only fire for the explicit RoomLeave packet, leaving a "ghost" player
  // for anyone whose room-mate crashed instead of leaving normally.
  if (room.players.size > 0) {
    const fields = [1, u.sessionId, oldSlot, room.players.size, room.master, u.xp, u.money];
    const sockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
    broadcastPacket(sockets, XOR.external, ROOM_LEAVE, fields);
  }

  return room;
}

// Split out of removeFromRoom so callers can send their own reply to the
// leaver (when there is one) before the lobby finds out - see
// removeFromRoom's comment for why the order matters.
function notifyLobbyAfterLeave(room) {
  if (room.players.size === 0) sendRoomDeleteToLobby(room.channel, room.id);
  else sendRoomUpdateToLobby(room, true);
}

// Ported from Game/Handlers/RoomLeave.cs + Packets/RoomLeave.cs. The
// broadcast to remaining room members (Room.Remove's second Send) now lives
// in removeFromRoom itself, shared with the disconnect path - this only
// still owns the reply to the leaver's own socket, sent before the lobby
// update (notifyLobbyAfterLeave) to match the reference's packet order.
//
// Also pushes the leaver a fresh full room-list page (same call
// handleChannelSelection already makes on first entering the lobby) -
// found live that the incremental ROOM_LIST_UPDATE broadcast alone doesn't
// make a room reappear in the real client's list after returning from one:
// the room stayed invisible until manually paging the list, which sends a
// real RoomList request/response round-trip. Not in the reference (its
// RoomLeave.cs only refreshes the leaver's *user* list, not the room list),
// but real client behavior wins.
function handleRoomLeave(socket, db) {
  const u = socket.user;
  if (!u || u.roomId === null) return;

  const chan = getChannel(u.channel);
  const oldSlot = chan.rooms.get(u.roomId)?.players.get(u.sessionId)?.slot ?? 0;

  const room = removeFromRoom(db, u);
  const fields = [1, u.sessionId, oldSlot, room ? room.players.size : 0, room ? room.master : 0, u.xp, u.money];
  socket.sendPacket(ROOM_LEAVE, fields);
  if (room) notifyLobbyAfterLeave(room);
  sendRoomList(socket, u.roomListPage || 0);
}

// Ported from Game/Handlers/ChangeChannel.cs' RoomList half.
function sendRoomList(socket, page) {
  const u = socket.user;
  const chan = getChannel(u.channel);
  const rooms = [...chan.rooms.values()].filter((r) => Math.floor(r.id / 8) === page);
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
// codebase has). Looked like a stub at first read - KickPlayer only ever
// sends this one notice, never touches Room.Players/Master/lobby - but a
// live capture against the real client showed why that's enough: the kicked
// client reacts to this notice by sending its own explicit RoomLeave right
// away, which already runs the real removal (removeFromRoom, below). Calling
// removeFromRoom *here* too was the actual bug this shipped with: it raced
// ahead of that RoomLeave, so by the time it arrived u.roomId was already
// null, handleRoomLeave's guard silently swallowed it with no reply packet
// at all, and the real client crashed waiting on one (ECONNRESET right
// after). Reference behavior, once you watch the real client obey it, was
// already complete - notify only, let the client's own leave do the rest.
function handleRoomKick(socket, pkt) {
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
}

const ROOM_INVITE_ERR = { INVITED: 93010, GENERIC: 93020, IN_ROOM: 93030 };

// Field order lifted from Packets/RoomInvite.cs's Append() calls reads fine
// on paper - [..., message, roomId, roomPassword] at the tail - and matches
// real captures embedded in WarRock-ToXiiC-Core's own source comments. But a
// live marker test (send a distinct value in every candidate slot, read
// back which ones the client's own follow-up RoomJoin used) showed the
// actual client we're targeting only ever picks up ONE of the two: password,
// from the slot right after the message. The other RoomJoin field always
// arrives as a literal 0, no matter what's sent in any slot - the client's
// "accept invite" flow doesn't echo a room id back at all, it sends a fixed
// sentinel and expects the server to already remember which room it invited
// that player to (see handleRoomJoin's u.pendingInviteRoomId). room.id is
// still sent here (harmless, unused) in case some client build does read it.
function inviteFields(inviter, message, room) {
  const clan = clanInfo(inviter);
  return [
    1, 0, -1,
    inviter.sessionId, inviter.sessionId,
    inviter.displayname,
    ...(clan ? [clan.id, clan.name, clan.rank, clan.rank] : [-1, -1, -1, -1]),
    1, 18, inviter.xp, 3, room.id, -1,
    message,
    room.password,
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
    picked.pendingInviteRoomId = room.id;
    picked.socket.sendPacket(ROOM_INVITE, inviteFields(u, message, room));
    return;
  }

  for (const other of users.values()) {
    if (other.displayname !== target) continue;
    if (other.roomId !== null) socket.sendPacket(ROOM_INVITE, [ROOM_INVITE_ERR.IN_ROOM]);
    else if (other.channel === u.channel) {
      other.pendingInviteRoomId = room.id;
      other.socket.sendPacket(ROOM_INVITE, inviteFields(u, message, room));
    }
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
  notifyLobbyAfterLeave,
  ROOM_CREATION,
  ROOM_JOIN,
  ROOM_LEAVE,
  ROOM_KICK,
  ROOM_INVITE,
  ROOM_LIST,
};
