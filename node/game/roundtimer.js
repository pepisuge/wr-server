const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { users, roomSockets } = require('./state');
const { applyMatchEnd } = require('./progression');
const { tickExplosive } = require('./explosive');

const GAME_TICK = 0x7540;
const END_GAME = 0x7560;

// Game/Enums/Mode.cs - only the three modes actually implemented here.
const EXPLOSIVE_MODE = 0;
const TDM_MODE = 2;

function countAlive(room, team) {
  return [...room.players.values()].filter((p) => p.team === team && p.alive).length;
}

// FreeForAll.Initilize's formula (intMaximumKills = 10 + 5*room.Setting) -
// shared by the win check and the live scoreboard below, so they can never
// disagree on what the target actually is.
function maxKills(room) {
  return 10 + 5 * room.setting;
}

function leaderKills(room) {
  return Math.max(0, ...[...room.players.values()].map((p) => p.kills));
}

// ScoreboardA()/ScoreboardB(): FFA = target kills / current leader's kills,
// TDM = each team's remaining ticket pool, Explosive = players alive per
// team. Shared by GameTick's live HUD value and the on-demand Scoreboard
// packet (gamesubs.js) so they can never disagree.
function scoreboardValues(room) {
  if (room.mode === TDM_MODE) return [room.tickets[0], room.tickets[1]];
  if (room.mode === EXPLOSIVE_MODE) return [countAlive(room, 0), countAlive(room, 1)];
  return [maxKills(room), leaderKills(room)];
}

// Ported (loosely) from Room.Process() + Packets/GameTick.cs. The reference
// runs a real per-room thread driving round timers, win conditions, vehicle
// respawns, and damage/kill scoring. ScoreboardA/B used to be hardcoded 0
// here - that's the "000" a player saw in the kill-target HUD instead of
// the room's actual setting. For TDM, ScoreboardA/B are the two teams'
// remaining ticket pools (TeamDeathMatch.ScoreboardA/B) instead of FFA's
// target-kills/leader-kills.
function startRoundTimer(room, db) {
  // Clan war: who was there at the start decides whether the result counts (see settleWar).
  if (room.isClanWar > 0) room.warTeams = [0, 1].map((t) => [...room.players.values()].filter((p) => p.team === t).length);
  room.upTick = 0;
  room.downTick = 3600000; // 1 hour, matches FreeForAll.Initilize's Room.DownTick - Explosive's own initExplosiveMatch overwrites this right after, per round
  room.tickInterval = setInterval(() => {
    const sockets = roomSockets(room);
    if (!sockets.length) {
      stopRoundTimer(room);
      return;
    }

    // Explosive drives its own round-by-round state machine (bomb, per-round
    // win, the 5s inter-round gate) - see explosive.js. FreezeTick mirrors
    // Room.Process(): no GameTick at all goes out during that gap, and the
    // up/down timers don't move either.
    if (room.mode === EXPLOSIVE_MODE) {
      const result = tickExplosive(room);
      if (result?.matchEnd) {
        endRound(room, db);
        return;
      }
      if (room.freezeTick) return;
      room.upTick += 1000;
      room.downTick -= 1000;
      const [scoreA, scoreB] = scoreboardValues(room);
      broadcastPacket(sockets, XOR.external, GAME_TICK, [
        room.upTick, room.downTick, room.teamRounds[0], room.teamRounds[1], scoreA, scoreB, 2, 0, 30,
      ]);
      return;
    }

    room.upTick += 1000;
    room.downTick -= 1000;
    const [scoreA, scoreB] = scoreboardValues(room);
    // ToXiiC-Core's RoomThread: TDM/Conquest send AliveDerb/AliveNIU here;
    // FFA leaves DerbRounds/NIURounds, never touched in that mode - stays 0/0.
    const [tickA, tickB] = room.mode === TDM_MODE ? [countAlive(room, 0), countAlive(room, 1)] : [0, 0];
    broadcastPacket(sockets, XOR.external, GAME_TICK, [room.upTick, room.downTick, tickA, tickB, scoreA, scoreB, 2, 0, 30]);
    if (room.downTick <= 0) endRound(room, db);
  }, 1000);
}

function stopRoundTimer(room) {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}

// Ported from FreeForAll's IsGoalReached/Process win checks (kill limit,
// or fewer than 2 players left) and TeamDeathMatch's own (either team's
// ticket pool exhausted, or a team has nobody left present - Conquest isn't
// implemented, ponytail).
function checkWinCondition(room) {
  if (room.state !== 2) return false;
  if (room.mode === EXPLOSIVE_MODE) return false; // round/match end is tick-polled (tickExplosive), not kill-event-triggered - OnDeath is a no-op in the reference

  if (room.mode === TDM_MODE) {
    if (room.tickets[0] <= 0 || room.tickets[1] <= 0) return true;
    const teamsPresent = new Set([...room.players.values()].map((p) => p.team));
    return teamsPresent.size < 2; // one side has no players left
  }

  if (room.players.size <= 1) return true;
  return [...room.players.values()].some((p) => p.kills >= maxKills(room));
}

// Ported from Room.EndGame() + Packets/EndGame.cs. `points` is just each
// player's kill count (ponytail: the reference's separate Points field
// needs objective-based modes - flags, bomb plants - none of which exist
// here yet).
//
// ponytail/bug found: the reference's real field order is
// [OK, CurrentRoundTeamA, CurrentRoundTeamB, killsDerb, deathsDerb, killsNIU,
// deathsNIU, 0, 0, playerCount, ...] (Packets/EndGame.cs) - CurrentRoundTeamA/B
// come right after OK, not after the kill/death totals. This file had them
// swapped: team round fields were sent in the trailing 0,0 slot while
// position 1-2 (what CurrentRoundTeamA/B actually is) stayed hardcoded at
// 0,0. Two live experiments (guide Fase 25 for FFA, and this session for
// Explosive, both directions) "disproved" changing the value at the *wrong*
// position - the client was always reading a fixed 0,0 for the field it
// actually uses, so of course nothing changed. Not yet re-tested live with
// the field order fixed - do that before declaring the win/lose mystery
// solved either way.
function endRound(room, db) {
  stopRoundTimer(room);
  room.state = 1; // Waiting

  const players = [...room.players.values()];
  const teamKills = [0, 0];
  const teamDeaths = [0, 0];
  for (const p of players) {
    teamKills[p.team] = (teamKills[p.team] || 0) + p.kills;
    teamDeaths[p.team] = (teamDeaths[p.team] || 0) + p.deaths;
  }

  // CurrentRoundTeamA/B (guide Fase 24/25's "round" fields): Explosive has
  // real per-round win counts (teamRounds). Other modes: ponytail hypothesis,
  // not a confirmed port - ToXiiC-Core's EndGame.cs sends
  // KillsDerbaranLeft/KillsNIULeft (our room.tickets) here instead of a
  // hardcoded 0/0, for every non-Explosive mode including FFA. Needs live
  // retest now that it's in the right packet position.
  if (room.isClanWar > 0) settleWar(room, db, players, teamKills);

  const roundFields =
    room.mode === EXPLOSIVE_MODE ? [room.teamRounds[0], room.teamRounds[1]] : [room.tickets[0], room.tickets[1]];
  const fields = [1, ...roundFields, teamKills[0], teamDeaths[0], teamKills[1], teamDeaths[1], 0, 0, players.length];
  for (const p of players) {
    const u = users.get(p.sessionId);
    const { xpEarned, moneyEarned } = u ? applyMatchEnd(db, u, p.kills) : { xpEarned: 0, moneyEarned: 0 };
    fields.push(p.slot, p.kills, p.deaths, 0, p.kills, moneyEarned, xpEarned, u ? u.xp : 0);
  }
  fields.push(room.master);

  const sockets = players.map((p) => users.get(p.sessionId)?.socket).filter(Boolean);
  if (sockets.length) broadcastPacket(sockets, XOR.external, END_GAME, fields);
}

// Clan war result (#11): team 0 is clan1 (the challenger), team 1 clan2. Counts only if both clans had players when
// the match started, so a war against an empty room earns nothing; a side that left by the end loses.
// Winner by rounds (Explosive), tickets (TDM), else kills; equal = draw.
function settleWar(room, db, players, teamKills) {
  const start = room.warTeams || [0, 0];
  room.warTeams = null; // once per match
  if (!start[0] || !start[1]) return;
  const present = [0, 1].map((t) => players.some((p) => p.team === t));
  let score;
  if (!present[0] || !present[1]) score = present.map(Number);
  else if (room.mode === EXPLOSIVE_MODE) score = room.teamRounds;
  else if (room.mode === TDM_MODE) score = room.tickets;
  else score = teamKills;
  const winner = score[0] === score[1] ? null : score[0] > score[1] ? room.clan1 : room.clan2;
  require('./clan').recordWar(db, room.clan1, room.clan2, winner);
}

module.exports = { settleWar, startRoundTimer, stopRoundTimer, checkWinCondition, endRound, scoreboardValues };
