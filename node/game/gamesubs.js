const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, users } = require('./state');
const { sendRoomUpdateToLobby, findFreeSlot } = require('./rooms');
const { startRoundTimer } = require('./roundtimer');

const GAME_PACKET = 0x7530;

// GameSubs ids, ported from Game/Enums/GameSubs.cs - the numbers that live
// inside a GamePacket, not top-level packet ids.
const SUB = {
  START: 1,
  START_REPLY: 4,
  CONFIRM_SPAWN: 100,
  MAP_UPDATE: 51,
  MODE_UPDATE: 52,
  CHANGE_ROUNDS: 53,
  CHANGE_KILLS: 55,
  READY: 50,
  SIDE_UPDATE: 56,
  PING_LIMIT: 59,
  SPAWN: 150,
  GET_MISSION: 402,
  START_MISSION: 403,
};

// A payload shorter than the highest index a handler writes would otherwise
// leave holes that serialize as the literal string "undefined" on the wire -
// pad with zeros instead of trusting the client sent enough fields.
function padded(payload, minLen) {
  const out = [...payload];
  while (out.length < minLen) out.push(0);
  return out;
}

// Ported from Game/Handlers/Game/Lobby/ToggleReady.cs. Reference disconnects
// the master for trying this (it's meant to be un-clickable client-side for
// them) - we just ignore it instead, less harsh for our own test client.
function handleReady(room, player, payload) {
  if (player.slot === room.master) return null;
  player.ready = !player.ready;
  const out = [...payload];
  out[2] = player.ready ? 1 : 0;
  return { payload: out };
}

// Ported from Game/Handlers/Game/Lobby/ChangeSide.cs + Room.SwitchSide.
// Each team owns half the room's slot numbers (team 0: low half, team 1:
// high half) - switching teams isn't just a flag flip, it moves the player
// to the first free slot in the *other* half, and reassigns Master if that
// slot was theirs. Skips the 200ms spam-guard from the reference.
function handleSideUpdate(room, player, payload) {
  if (room.isClanWar > 0) return null; // Room.SwitchSide: !isClanWar guards free team-swap
  const targetTeam = Number(payload[2]);
  if (!(targetTeam === 0 || targetTeam === 1) || targetTeam === player.team) return null;

  const newSlot = findFreeSlot(room, targetTeam, player);
  if (newSlot === null) return null; // target team full

  if (player.slot === room.master) room.master = newSlot;
  player.slot = newSlot;
  player.team = targetTeam;

  const out = [...payload];
  out[2] = player.team;
  out[3] = player.slot; // the *new* slot - the header still carries the old one
  out[4] = room.master;
  return { payload: out };
}

// Ported from Game/Handlers/Game/Lobby/Start.cs. Skips the AccessLevel/
// AllowStartAlone override and the team-balance check - just "everyone
// ready, at least 2 players". Doesn't actually load a map (no MapManager
// yet) - just flips the room to Playing so the client moves on.
function handleStart(room, player, payload) {
  if (player.slot !== room.master || room.state !== 1) return null;
  const players = [...room.players.values()];
  if (!players.every((p) => p.ready) || players.length < 2) return null;

  room.state = 2; // Playing
  startRoundTimer(room);
  const out = [...payload];
  out[2] = room.map;
  return { newType: SUB.START_REPLY, payload: out, updateLobby: true };
}

// Ported from Game/Handlers/Game/{ChangeMap,ChangeMode,ChangeSubMode,ChangePinglimit}.cs.
// All four are the same shape: master-only, room still Waiting, apply
// payload[2] to one room field, echo it back as the ack. Real map/mode
// rotation validity (does this map exist for this mode?) isn't checked -
// this just records whatever the client's own UI already validated.
function settingHandler(field) {
  return (room, player, payload) => {
    if (player.slot !== room.master || room.state !== 1) return null;
    room[field] = Number(payload[2]);
    return { payload, updateLobby: true };
  };
}

// Ported from Game/Handlers/Game/Ingame/Setup.cs. The reference's own
// comments read "Set(2, 3); // ?" - these four values are magic constants
// nobody fully documented even in the original, so they're copied as-is
// rather than guessed at. Reply goes only to the asker (selfTarget), not
// broadcast - matches the reference. Skips starting a Room.Process() tick
// loop (round timers, win conditions) - out of scope until real combat is.
function handleGetMission(room, player, payload) {
  if (room.state !== 2) return null;
  const out = padded(payload, 6);
  out[2] = 3;
  out[3] = 500;
  out[4] = 0;
  out[5] = 1;
  return { newType: SUB.START_MISSION, payload: out, selfTarget: true };
}

// Ported from Game/Handlers/Game/Ingame/Spawn.cs. Skips the real spawn-point
// selection (Room.CurrentGameMode.SpawnSlot(), needs map data we don't have)
// and any alive/dead/CanSpawn state - always allows spawning at slot 0.
function handleSpawn(room, player, payload) {
  if (room.state !== 2) return null;
  const out = padded(payload, 10);
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  return { payload: out };
}

// Ported from Game/Handlers/Game/Ingame/ConfirmSpawn.cs - a fire-and-forget
// ack from the client once it's finished spawning in; the reference never
// sets respond=true for it either, so no reply is expected.
function handleConfirmSpawn() {
  return null;
}

const HANDLERS = {
  [SUB.READY]: handleReady,
  [SUB.SIDE_UPDATE]: handleSideUpdate,
  [SUB.START]: handleStart,
  [SUB.MAP_UPDATE]: settingHandler('map'),
  [SUB.MODE_UPDATE]: settingHandler('mode'),
  [SUB.CHANGE_ROUNDS]: settingHandler('setting'),
  [SUB.CHANGE_KILLS]: settingHandler('setting'),
  [SUB.PING_LIMIT]: settingHandler('pingLimit'),
  [SUB.GET_MISSION]: handleGetMission,
  [SUB.SPAWN]: handleSpawn,
  [SUB.CONFIRM_SPAWN]: handleConfirmSpawn,
};

// Ported from Game/Networking/GameDataHandler.cs' shared envelope: every
// in-room action rides inside one packet id (GamePacket), with a 4-field
// header (sender slot, room id, an unidentified passthrough field, sub-type)
// followed by a sub-type-specific payload. The reply mirrors that shape and
// is normally broadcast to the whole room, sender included.
function handleGamePacket(socket, pkt) {
  const u = socket.user;
  if (!u || u.roomId === null) return;

  const roomSlot = Number(pkt.blocks[0]);
  const roomId = Number(pkt.blocks[1]);
  const unknown = pkt.blocks[2];
  const subType = Number(pkt.blocks[3]);
  const payload = pkt.blocks.slice(4);

  const room = getChannel(u.channel).rooms.get(u.roomId);
  if (!room || room.id !== roomId) return;

  const player = room.players.get(u.sessionId);
  if (!player || player.slot !== roomSlot) return;

  const handler = HANDLERS[subType];
  if (!handler) return; // unrecognized/out-of-scope sub-type - silently ignored, matches Fase 4's GamePacket note

  // The header's slot reflects who sent the packet (their slot *before* the
  // handler runs) - SideUpdate moves the player to a new slot as a side
  // effect, but that new slot only shows up in the payload, not the header.
  // Getting this backwards was the original bug: the client couldn't find
  // the row to update and rendered it blank.
  const originalSlot = player.slot;
  const result = handler(room, player, payload, u);
  if (!result) return;

  const fields = [1, originalSlot, room.id, unknown, result.newType ?? subType, ...(result.payload ?? payload)];
  const sockets = result.selfTarget
    ? [socket]
    : [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
  broadcastPacket(sockets, XOR.external, GAME_PACKET, fields);

  if (result.updateLobby) sendRoomUpdateToLobby(room, true);
}

module.exports = { handleGamePacket, GAME_PACKET };
