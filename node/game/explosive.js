// Ported from Modes/Explosive.cs - CQC's default mode: short rounds, each
// with a bomb plant/defuse objective, played until one team reaches
// GameConfig.RoundLimits[room.setting] round wins. Chosen with the user as
// a full-fidelity port, including StartRound/EndRound's own undocumented
// magic constants (coordinate-looking triples, six repeated "0.0000"
// strings, a fixed "DS05") - nobody, not even the original project,
// explained these; they're copied verbatim, same as GetMission's magic
// numbers (Fase 9) were, and corrected once real capture shows what's wrong.
const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, roomSockets } = require('./state');
const { GameConfig } = require('./progression');

const GAME_PACKET = 0x7530;
const EXPLOSIVES = 0x7520; // top-level opcode - NOT a GameSub, never goes through handleGamePacket

const SUB_START_MISSION = 403; // reused as-is from Fase 9's GetMission/StartMission
const SUB_START_ROUND = 5; // unnamed in GameSubs.cs - never given an enum entry, used as a raw number even in the reference
const SUB_END_ROUND = 6; // same

const ROUND_LIMITS = [1, 3, 5, 7, 9]; // Constants.RoundLimits, indexed by room.setting

function countAlive(room, team) {
  return [...room.players.values()].filter((p) => p.team === team && p.alive).length;
}


// Ported from Explosive's constructor + Initilize(). Called once from
// gamesubs.js's handleStart when room.mode is Explosive, right after the
// generic per-round player reset it already does.
function initExplosiveMatch(room) {
  room.currentRound = 0;
  room.teamRounds = [0, 0];
  room.roundLimit = ROUND_LIMITS[room.setting] ?? 1;
  room.roundEndAt = 0; // far enough in the past that prepareRound's 5s gate passes immediately
  room.roundActive = false;
  room.freezeTick = false;
  for (const p of room.players.values()) p.roundWait = false;
  prepareRound(room, true);
  room.roundActive = true;
}

// Ported from PrepareRound(). The 5s real-time gate and the "everyone acked
// RoundEndConfirm" gate both trivially pass on the very first call (fresh
// state) - `first` only matters for skipping the round counter and the
// Mission/StartRound broadcasts, since there's nothing to announce yet (the
// match-start flow, Fase 9, already told the client play has begun).
// Returns true (round started), false (still waiting), or 'match-end' (one
// side had nobody left between rounds - caller ends the whole match).
function prepareRound(room, first) {
  if (Date.now() - room.roundEndAt < 5000) return false;

  room.freezeTick = false;
  if (!first) room.currentRound += 1;

  if (![...room.players.values()].every((p) => !p.roundWait)) return false;

  // Entities/Player.cs's RoundStart(): Health=1000. Confirmed NOT an
  // Explosive-only override (was assumed so here until a live test with
  // real per-weapon damage exposed near-one-shot pistol kills) - both
  // references set 1000 as the universal baseline for every mode.
  for (const p of room.players.values()) {
    p.health = 1000;
    p.alive = true;
  }
  room.upTick = 0;
  room.downTick = GameConfig.explosiveRoundTime;
  room.bombPlanted = false;
  room.bombDefused = false;
  room.bombSide = -1;

  if (!first && room.currentRound > 0) {
    if (!GameConfig.allowStartAlone && (countAlive(room, 0) === 0 || countAlive(room, 1) === 0)) {
      return 'match-end';
    }
    broadcastMission(room);
    broadcastStartRound(room);
  }
  return true;
}

// Ported from Packets/Mission.cs - reuses the same StartMission GameSub
// (403) the existing GetMission flow already answers on request (Fase 9),
// pushed to the whole room instead of only the asker. ponytail: one field
// (payload position 3) differed from GetMission's in the one real capture
// available (363 vs 500) - not understood well enough to know which is
// right for a round-start push, kept at 500 for consistency with the
// already-working GetMission response until a real capture says otherwise.
function broadcastMission(room) {
  const fields = [1, -1, room.id, 2, SUB_START_MISSION, 0, 1, 3, 500, 0, 1, 0, 0, 0, 0];
  broadcastPacket(roomSockets(room), XOR.external, GAME_PACKET, fields);
}

// Ported from Packets/StartRound.cs verbatim.
function broadcastStartRound(room) {
  const fields = [
    1, -1, room.id, 1, SUB_START_ROUND,
    0, room.teamRounds[0], room.teamRounds[1],
    1, 0, 5, 0, 0, -1, 0, 0,
    800000, -184460, 800000,
    1200000, -900000, 1200000,
    '0.0000', '0.0000', '0.0000', '0.0000', '0.0000', '0.0000',
    0, 0,
    'DS05',
  ];
  broadcastPacket(roomSockets(room), XOR.external, GAME_PACKET, fields);
}

// Ported from EndRound() + Packets/EndRound.cs - the per-ROUND result
// (distinct from the whole-MATCH EndGame in roundtimer.js, only sent once
// room.teamRounds[winner] reaches room.roundLimit). Field order verified
// against the reference field-by-field - already correct.
//
// A live test inverting `winner`/teamRounds here made no difference to the
// client's win/lose banner - but that's inconclusive on its own: this is
// only the mid-match "round over" popup, not necessarily the results screen
// that shows Win/Lose. roundtimer.js's EndGame packet had a real field-order
// bug (CurrentRoundTeamA/B in the wrong slot) which better explains the
// earlier failed experiments - fix that first and retest live before
// concluding anything about this packet specifically.
function broadcastEndRound(room, winner) {
  const fields = [
    1, -1, room.id, 1, SUB_END_ROUND,
    0, 1, winner, room.teamRounds[0], room.teamRounds[1],
    room.roundLimit, 0, 92, -1, 0, 0,
    1200000, -900000, 1200000,
    '0.0000', '0.0000', '0.0000', '0.0000', '0.0000', '0.0000',
    0, 0,
    'DS05',
  ];
  broadcastPacket(roomSockets(room), XOR.external, GAME_PACKET, fields);
}

function endExplosiveRound(room, winner) {
  room.roundActive = false;
  room.roundEndAt = Date.now();
  room.freezeTick = true;
  for (const p of room.players.values()) p.roundWait = true;

  room.teamRounds[winner] = (room.teamRounds[winner] || 0) + 1;
  broadcastEndRound(room, winner);
}

// Ported from Room.Process()'s Explosive branch - called once a second from
// roundtimer.js's own tick, same cadence as the reference's polling loop.
// Returns null (nothing further to do this tick) or { matchEnd, winner }
// when the whole match is over - roundtimer.js calls its own endRound()
// for that, keeping this module from needing to import it back (it already
// imports this one).
function tickExplosive(room) {
  if (!room.roundActive) {
    const result = prepareRound(room, false);
    if (result === true) room.roundActive = true;
    else if (result === 'match-end') return { matchEnd: true, winner: countAlive(room, 0) > 0 ? 0 : 1 };
    return null;
  }

  const alive0 = countAlive(room, 0);
  const alive1 = countAlive(room, 1);

  let running = true;
  if (!GameConfig.allowStartAlone) {
    if (alive0 === 0 && !room.bombPlanted) running = false;
    if (alive1 === 0) running = false;
  }
  if (room.bombPlanted && room.bombDefused) running = false;
  if (room.downTick <= 0) running = false;
  if (running) return null;

  // Ported from WinningTeam(): bomb defused, or Derbaran wiped without a
  // bomb planted, or time ran out without a bomb planted -> NIU (1) wins;
  // otherwise Derbaran (0).
  const winner =
    (room.bombPlanted && room.bombDefused) || (!room.bombPlanted && alive0 === 0) || (!room.bombPlanted && room.downTick <= 0)
      ? 1
      : 0;

  // ponytail: was checking teamRounds[winner] < roundLimit BEFORE the
  // increment inside endExplosiveRound - required 2 round wins to end a
  // roundLimit=1 match. ToXiiC-Core's prepareRound() increments first, then
  // compares with >= - same fix here.
  endExplosiveRound(room, winner);
  if (room.teamRounds[winner] >= room.roundLimit) return { matchEnd: true, winner };
  return null;
}

// Ported from Handlers/Explosives.cs + Explosive.HandleExplosives. A
// top-level opcode, not a GameSub - the client sends this bomb plant/defuse
// packet directly, so it never reaches handleGamePacket's dispatch at all.
// Echoes the raw incoming blocks back to the room (Packets/Explosives.cs
// does the same - just re-wraps whatever it received), only inspecting
// item type (blocks[2]) and bomb side (blocks[4]). ponytail: skips the
// reference's Classes.Heavy check on the TMA branch (type 2) - no player
// class tracked here yet, so it's allowed unconditionally instead of never.
function handleExplosivesPacket(socket, pkt) {
  const u = socket.user;
  if (!u || u.roomId === null) return;
  const room = getChannel(u.channel).rooms.get(u.roomId);
  if (!room) return;
  const player = room.players.get(u.sessionId);
  if (!player || !player.alive) return;

  const blocks = pkt.blocks;
  const type = Number(blocks[2]);

  if (type === 0) {
    if (player.team === 0 && !room.bombPlanted) {
      room.bombPlanted = true;
      room.bombDefused = false;
      room.bombSide = Number(blocks[4]);
      room.downTick = GameConfig.bombTime;
    } else if (player.team === 1 && room.bombPlanted) {
      room.bombDefused = true;
    } else {
      return;
    }
  } else if (type === 1) {
    return; // no-op in the reference too - consumed, nothing broadcast
  } else if (type !== 2) {
    socket.end(); // unknown item type - probable manipulated packet, same "disconnect" treatment used elsewhere in this project
    return;
  }

  broadcastPacket(roomSockets(room), XOR.external, EXPLOSIVES, [1, ...blocks, 0]);
}

module.exports = {
  initExplosiveMatch,
  tickExplosive,
  handleExplosivesPacket,
  EXPLOSIVES,
};
