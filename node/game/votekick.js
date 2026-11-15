// Votekick (GameSub 61), protocol from WarRock-ToXiiC-Core's RoomHandler_VoteKick checked against client 22:
// - request: payload[2]=0, payload[3]=target slot (captured: [0, 0, 2, 61, 1, 0, 0, 3, 0...]);
// - the server opens the vote to the target's team: payload[2]=1, [3]=target, [6]=requester (FUN_004e45a0);
// - Y sends payload[2]=1, [3]=target; N sends nothing (FUN_005dcf.. key handler), so every vote received is a yes;
// - result to the same team: payload[2]=2, [3]=target, [5]>=80 shows "has been kicked", below it "was not kicked".
// A kicked player gets the same ROOM_KICK notice as a master kick (its client then leaves) and cannot rejoin for 5 min.
const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { users } = require('./state');

const GAME_PACKET = 0x7530;
const VOTE_KICK = 61;
const ROOM_KICK = 0x7341;
const FFA_MODE = 1;
const VOTE_MS = 30000; // the client counts down 30 s
const COOLDOWN_MS = 60000; // after any vote, as the reference
const LOCK_MS = 5 * 60000; // kicked player kept out of the room, as the reference
// Client error popups (FUN_005f2d20, texts m993*).
const ERR = { IN_PROGRESS: 96150, CANNOT: 96151, INVALID: 96152, OPPOSING: 96153, NEED_4: 96154 };

function teamSockets(room, team) {
  return [...room.players.values()].filter((p) => p.team === team).map((p) => users.get(p.sessionId)?.socket).filter(Boolean);
}

function send(room, team, payload) {
  broadcastPacket(teamSockets(room, team), XOR.external, GAME_PACKET, [1, -1, room.id, 2, VOTE_KICK, ...payload]);
}

function finish(room, kicked) {
  const v = room.vote;
  clearTimeout(v.timer);
  room.vote = null;
  room.voteCooldownUntil = Date.now() + COOLDOWN_MS;
  send(room, v.team, [kicked ? 1 : 0, kicked ? 0 : 1, 2, v.targetSlot, kicked ? 1 : 0, kicked ? 100 : 0, 0, 0, 0, 0]);
  const target = [...room.players.values()].find((p) => p.slot === v.targetSlot && p.userId === v.targetUserId);
  if (!kicked || !target) return;
  (room.voteLocked ??= new Map()).set(target.userId, Date.now() + LOCK_MS);
  users.get(target.sessionId)?.socket.sendPacket(ROOM_KICK, [1, target.slot]);
}

// Majority of the target's team, the target included (reference: votes >= teamSize / 2 + 1).
function tally(room) {
  const teamSize = [...room.players.values()].filter((p) => p.team === room.vote.team).length;
  if (room.vote.yes.size >= Math.floor(teamSize / 2) + 1) finish(room, true);
}

function handleVoteKick(room, player, payload, u) {
  const error = (code) => (u.socket.sendPacket(GAME_PACKET, [code]), null);
  const targetSlot = Number(payload[3]);
  const target = [...room.players.values()].find((p) => p.slot === targetSlot);

  if (Number(payload[2]) === 1 && room.vote) {
    // a yes vote: only from the target's team, once per player
    if (player.team === room.vote.team && targetSlot === room.vote.targetSlot) room.vote.yes.add(player.userId);
    tally(room);
    return null;
  }
  if (Number(payload[2]) !== 0) return null;

  if (room.mode === FFA_MODE || !room.enableVoteKick || room.state !== 2) return error(ERR.CANNOT);
  if (!target || target === player || users.get(target.sessionId)?.isGm) return error(ERR.INVALID);
  if (target.team !== player.team) return error(ERR.OPPOSING);
  if (room.vote) return error(ERR.IN_PROGRESS);
  if ([...room.players.values()].filter((p) => p.team === player.team).length < 4) return error(ERR.NEED_4);
  if (Date.now() < (room.voteCooldownUntil || 0)) return error(ERR.CANNOT);

  room.vote = { team: target.team, targetSlot, targetUserId: target.userId, yes: new Set([player.userId]) };
  room.vote.timer = setTimeout(() => room.vote && finish(room, false), VOTE_MS);
  send(room, target.team, [0, 0, 1, targetSlot, 0, 0, player.slot, 0, 0, 0]);
  return null;
}

module.exports = { handleVoteKick, VOTE_KICK };
