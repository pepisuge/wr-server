const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, users } = require('./state');
const { sendRoomUpdateToLobby, sendRoomPlayers, findFreeSlot } = require('./rooms');
const { startRoundTimer, checkWinCondition, endRound, scoreboardValues } = require('./roundtimer');
const { getMap } = require('./maps');
const { initExplosiveMatch } = require('./explosive');

const GAME_PACKET = 0x7530;
const SCOREBOARD = 0x7550;

// Game/Enums/Mode.cs - only the three modes actually implemented here.
const EXPLOSIVE_MODE = 0;
const FFA_MODE = 1;
const TDM_MODE = 2;

// Modes/TeamDeathMatch.cs's Constants.TDMTickets, indexed by room.setting.
const TDM_TICKETS = [30, 50, 100, 150, 200, 300];

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
  USER_LIMIT: 58,
  PING_LIMIT: 59,
  SPAWN: 150,
  GET_MISSION: 402,
  START_MISSION: 403,
  PLAYER_DAMAGE: 103,
  PLAYER_DEATH: 152,
  CONFIRM_DEATH: 154,
  BACK_TO_LOBBY: 9,
  AMMO_RECHARGE: 105,
  WEAPON_SWITCH: 155,
  SUICIDE: 157,
  ROUND_END_CONFIRM: 7,
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
function handleStart(room, player, payload, u, db) {
  if (player.slot !== room.master || room.state !== 1) return null;
  const players = [...room.players.values()];
  if (!players.every((p) => p.ready) || players.length < 2) return null;

  // Fresh round: clear last round's health/kills/deaths (Player.Reset/RoundStart).
  for (const p of players) {
    p.health = 100;
    p.alive = true;
    p.kills = 0;
    p.deaths = 0;
    p.inLobby = false;
  }
  room.spawnPoint = undefined;

  // Ported from Room.Start()'s Flags/SpawnFlags setup (maps.js, backed by
  // the real map_data table). Doesn't pick which flag Spawn's index maps to
  // (see nextSpawnSlot) - this just makes the map's real two team spawn-flag
  // indices available on the room for logging/future flag-capture work,
  // instead of being invisible.
  const map = getMap(room.map);
  if (map) {
    room.flags = new Array(map.flagCount).fill(-1);
    room.flags[map.spawnFlags[0]] = 0;
    room.flags[map.spawnFlags[1]] = 1;
    console.log(
      `Room ${room.id}: map ${room.map} (${map.name}), ${map.flagCount} flags, spawn flags [${map.spawnFlags.join(', ')}]`
    );
  }
  // TeamDeathMatch.Initilize's ticket pools - one per team, both start full.
  // Not meaningful for other modes, but harmless to set regardless.
  room.tickets = [TDM_TICKETS[room.setting] ?? 30, TDM_TICKETS[room.setting] ?? 30];
  room.state = 2; // Playing
  startRoundTimer(room, db);
  // Explosive's own round-state init (currentRound/teamRounds/bomb/downTick)
  // must run after startRoundTimer - that call unconditionally stamps a
  // generic downTick (3600000) first, which initExplosiveMatch then
  // overwrites with the real per-round time (Fase 27).
  if (room.mode === EXPLOSIVE_MODE) initExplosiveMatch(room);
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

// Ported from Handlers/Game/Lobby/ToggleUserlimit.cs: host-only, only while
// Waiting, flips Room.UserLimit and echoes the new state back in payload[2].
// Unlike settingHandler above, this doesn't read the value from the client -
// it's a toggle the server owns, not a value the client sets.
function handleUserLimit(room, player, payload) {
  if (player.slot !== room.master || room.state !== 1) return null;
  room.userLimit = !room.userLimit;
  const out = padded(payload, 3);
  out[2] = room.userLimit ? 1 : 0;
  return { payload: out, updateLobby: true };
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

// Ported from Modes/FreeForAll.cs's SpawnSlot(): a round-robin index over up
// to 20 spawn points, one counter shared by the whole room - the first spawn
// of a round returns 0, every one after increments and wraps. room.spawnPoint
// is reset (see handleStart) whenever a new round begins, matching
// Initilize()'s blnFirstSpawn=true. ponytail: no real per-map spawn-point
// *positions* (no MapManager/map data here) - this only varies which index
// the client is told, which is what actually stops everyone rendering on
// top of each other; it's not verified against a real map's actual layout.
//
// Neither TDM's nor Explosive's SpawnSlot() is overridden in the
// reference - both inherit GameMode's own `return 0;`, no round-robin at
// all (only FreeForAll.cs overrides it). Confirmed dead end after live
// testing this index exhaustively for TDM across two sessions: a per-team
// round-robin, a shared round-robin (0,1,2), and a wide deliberate spread
// (-2, -1, 2, 10) covering sign, parity and magnitude - every single value
// landed players at the same correct per-team point every time. A same
// index (1) even reproduced a *different* point across two separate
// matches, and the payload's other fields (0-6, client-supplied, never
// decoded - see scheduleAutoRespawn) didn't correlate with that difference
// either. Whatever picks between a flag's spawn points for TDM isn't
// reachable through anything this server sends - same class of limit as the
// boneId/offset-33 mysteries (guide, Fase 11/24): needs a disassembler, not
// more guessing here. Reverted to the faithful `return 0` for anything but
// FFA.
function nextSpawnSlot(room) {
  if (room.mode !== FFA_MODE) return 0;
  room.spawnPoint = room.spawnPoint === undefined ? 0 : (room.spawnPoint + 1) % 20;
  return room.spawnPoint;
}

// Investigation tools (gm.js's /spawnfields, /spawncycle) - both opt-in,
// off by default, never touch a real match unless a GM explicitly sets
// them. /spawnfields forces the whole 0-6 identity block; /spawncycle only
// rotates idx2 (the one field confirmed to select the point) through a
// GM-curated, already-verified-safe list, per team, leaving the player's
// own real fields (class etc.) untouched. Neither ever invents a value on
// its own - wrong ones have crashed the client outright or locked it in a
// respawn loop, and which values are safe isn't stable session to session.
function applySpawnTestOverrides(room, player, fields) {
  if (room.spawnTestFields) {
    for (let i = 0; i < 7; i++) fields[i] = room.spawnTestFields[i];
    return;
  }
  const cycle = room.spawnCycle?.[player.team];
  if (cycle) {
    fields[2] = cycle.values[cycle.index % cycle.values.length];
    cycle.index += 1;
  }
}

// Ported from Game/Handlers/Game/Ingame/Spawn.cs. Skips any alive/dead/
// CanSpawn state beyond what handlePlayerDamage already tracks - always
// allows (re)spawning while the room is Playing.
function handleSpawn(room, player, payload) {
  if (room.state !== 2) return null;
  clearAutoRespawn(player); // the client made it here on its own, no need for the safety net
  player.health = 100; // covers first spawn and every respawn after a death
  player.alive = true;
  const out = padded(payload, 10);
  const slot = nextSpawnSlot(room);
  applySpawnTestOverrides(room, player, out);
  out[7] = slot;
  out[8] = slot;
  out[9] = slot;
  player.lastSpawnPayload = out; // see scheduleAutoRespawn - the client's own payload carries context (team/class?) we can't reconstruct from scratch
  return { payload: out };
}

// Ported from Game/Handlers/Game/Ingame/ConfirmSpawn.cs - a fire-and-forget
// ack from the client once it's finished spawning in; the reference never
// sets respond=true for it either, so no reply is expected.
function handleConfirmSpawn() {
  return null;
}

// Ported from Objects/GameMode.cs's OnDamage/DamagePlayer, simplified.
// ponytail: flat damage per hit instead of the reference's real formula
// (weapon Power/PowerPersonal x hitbox multiplier, from GetHitBoxMultiplier
// + DamageCalculator) - our item catalog doesn't carry those stats yet.
// Upgrade once the item catalog has weapon stats. Kills/deaths persist to
// user_details immediately (fire-and-forget, same pattern as
// checkPremiumExpiry).
//
// The hitbox multipliers themselves ARE weapon-independent though (DB table
// `damage_multipliers`: head 1.5, torso 0.75, lower limbs 0.33, sniper-zone
// 1.5 - GameMode.cs's GetHitBoxMultiplier), so the 4 HSCalculation zones
// (Enums/Hitbox.cs) can be ported in ratio against FLAT_DAMAGE (=torso, the
// existing baseline) without the item catalog. Only the true head zone
// (1237) counts as a real headshot (icon/stat) - the reference excludes
// knives/rockets even on a head hit (`GameMode.cs`: weapon code not
// DA/DJ/DK), and the sniper zone (1243) does the same x2 damage as a
// headshot without being flagged as one at all.
const FLAT_DAMAGE = 25; // torso baseline (HSCalculation 1239, x1.0)
const HITBOX_DAMAGE = {
  1237: FLAT_DAMAGE * 2, // head/neck, x1.5 absolute -> x2 relative to torso
  1239: FLAT_DAMAGE, // torso/limbs
  1241: Math.round(FLAT_DAMAGE * 0.44), // lower limbs, x0.33 absolute -> x0.44 relative
  1243: FLAT_DAMAGE * 2, // sniper-only bone, same damage as a headshot but not one
};
const NO_HEADSHOT_WEAPON = /^(DA|DJ|DK)/; // knives, rockets - never credited as a headshot

function handlePlayerDamage(room, player, payload, u, db) {
  if (room.state !== 2 || payload.length !== 23 || Number(payload[2]) !== 1) return null;

  const targetSlot = Number(payload[3]);
  const victim = [...room.players.values()].find((p) => p.slot === targetSlot);
  if (!victim || victim === player || !victim.alive) return null;

  // Ported from CanInFlictDamageTo/isFriendlyFire: FFA ignores team entirely
  // (Attacker.Team != Victim.Team || Room.FriendlyFire || Mode == FFA). Same
  // team, non-FFA, friendlyFire off -> the hit doesn't happen at all.
  const sameTeam = player.team === victim.team;
  const friendlyFire = room.mode !== FFA_MODE && sameTeam && room.friendlyFire;
  if (room.mode !== FFA_MODE && sameTeam && !room.friendlyFire) return null;

  // boneId (payload[11], = blocks[15]) - sessionId: matches the reference's
  // Hitbox enum (1237 head, 1239 torso/limbs, 1241 lower limbs, 1243 sniper
  // bone) - confirmed against real captures (guide Fase 24: 1237/1241 for
  // "head" hits, 1239 for a "body" hit) and independently against
  // WarRock-ToXiiC-Core's Damage.cs, which hardcodes the same three numbers.
  const hsCalc = Number(payload[11]) - u.sessionId;
  const weapon = String(payload[22] || '');
  const headshot = hsCalc === 1237 && !NO_HEADSHOT_WEAPON.test(weapon);
  const damage = HITBOX_DAMAGE[hsCalc] ?? FLAT_DAMAGE;

  const previousHealth = victim.health;
  victim.health = Math.max(0, victim.health - damage);

  const out = [...payload];
  out[12] = victim.health;
  out[13] = previousHealth;
  // shootenPart, the client's headshot hit-marker: offset 17 for the older
  // clients this server targets (per Damage.cs's own "22 = Nexon - 21/17 =
  // Older clients" note), not 18 - fixed off-by-one against the reference.
  if (headshot) out[17] = '99.0000';

  if (victim.health > 0) return { payload: out };

  victim.alive = false;

  if (friendlyFire) {
    // DamagePlayer's FF branch: no AddDeaths/AddKill/OnDeath - the attacker
    // is penalized instead (AddFakeDeath + SubtractKill), and no ticket
    // pool is touched. No win-condition check either - killing a teammate
    // can't end the round.
    player.kills = Math.max(0, player.kills - 1);
    player.deaths += 1;
    db.query('UPDATE user_details SET deaths = deaths + 1, kills = GREATEST(0, CAST(kills AS SIGNED) - 1) WHERE id = ?', [
      player.userId,
    ]).catch((err) => console.error('PlayerDamage: failed to persist friendly-fire penalty:', err.message));
    sendRoomPlayers(
      [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean),
      [player]
    );
    return { newType: SUB.PLAYER_DEATH, payload: out };
  }

  victim.deaths += 1;
  player.kills += 1;
  db.query('UPDATE user_details SET deaths = deaths + 1 WHERE id = ?', [victim.userId]).catch((err) =>
    console.error('PlayerDamage: failed to persist death:', err.message)
  );
  db.query('UPDATE user_details SET kills = kills + 1 WHERE id = ?', [player.userId]).catch((err) =>
    console.error('PlayerDamage: failed to persist kill:', err.message)
  );
  if (headshot) {
    db.query('UPDATE user_details SET headshots = headshots + 1 WHERE id = ?', [player.userId]).catch((err) =>
      console.error('PlayerDamage: failed to persist headshot:', err.message)
    );
  }
  // The room roster (PLAYER_INFO) only ever went out once, at join time -
  // kills/deaths kept changing in our own state but the client's in-match
  // scoreboard never heard about it. Push both rows whenever they change.
  sendRoomPlayers(
    [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean),
    [player, victim]
  );

  // TeamDeathMatch.OnDeath: a normal kill drains the *victim's own team*
  // ticket pool, not the attacker's. ponytail: unconditional now, not just
  // TDM - ToXiiC-Core's OnDie() decrements this for every mode (User.cs),
  // and EndGame.cs sends it as the FFA/TDM "round" fields too (see
  // roundtimer.js). Hypothesis for the FFA win/lose mystery, needs retest.
  room.tickets[victim.team] -= 1;

  // Ported from OnDeath's trigger point in FreeForAll (checked right where a
  // kill lands, not just on the tick loop - room.js's roundtimer only ticks
  // once a second, that's too coarse for "you just won").
  if (checkWinCondition(room)) {
    endRound(room, db);
    sendRoomUpdateToLobby(room, true);
  }
  return { newType: SUB.PLAYER_DEATH, payload: out };
}

// Unlike ConfirmSpawn, there is no Handlers/Game/Ingame/ConfirmDeath.cs at
// all in the reference - the opcode exists in GameSubs.cs but was never
// wired to anything, same "name is real, behavior isn't" gap already seen
// for clan/GM commands (Fase 14/15). Originally treated as fire-and-forget
// by analogy with ConfirmSpawn - real capture disagreed: without an echoed
// reply, the client waited a few seconds after confirming its own death and
// then quietly left the room on its own, never having requested a respawn.
// Every other implemented GameSub acks the client's own action before it
// moves on (READY, WeaponSwitch, BackToLobby...) - this is that same
// pattern, designed from scratch since the reference has nothing to port.
function handleConfirmDeath(room, player, payload) {
  scheduleAutoRespawn(room, player);
  return { payload, selfTarget: true };
}

// Safety net, not a ported behavior - but the original 5000ms threshold was
// a misdiagnosis: a live test (3 real TDM deaths, no override active) showed
// the client sending its own explicit Spawn every single time, spontaneously,
// ~19s after ConfirmDeath (18.9s/19.4s/19.5s across the three) - not "stuck",
// just slower than we assumed. The 5s timer was firing on *every* death,
// silently replacing the client's own correct, fresh, real spawn-point choice
// with a stale one frozen from the match's first spawn - this is what made
// the TDM spawn-point investigation look unsolvable for so long (see
// nextSpawnSlot's comment and gm.js's /spawnfields/spawncycle): we were never
// actually observing the real client's behavior. 25s gives a safety margin
// above the observed ~19s without still routinely cutting the client off.
const AUTO_RESPAWN_MS = 25000;

function clearAutoRespawn(player) {
  if (player.respawnTimer) {
    clearTimeout(player.respawnTimer);
    player.respawnTimer = null;
  }
}

function scheduleAutoRespawn(room, player) {
  clearAutoRespawn(player);
  player.respawnTimer = setTimeout(() => {
    player.respawnTimer = null;
    // Re-checked here, not just at schedule time: by the time this fires,
    // the round may have ended, the player may have left, or (the normal
    // case) they may have already respawned on their own.
    if (room.state !== 2 || player.alive || !room.players.has(player.sessionId)) return;

    player.health = 100;
    player.alive = true;
    // TDM never sends an explicit Spawn request after the first one of the
    // match in practice - every respawn observed live went through this
    // timer instead (see nextSpawnSlot's comment for the now-closed
    // spawn-point index investigation this timer was also used for).
    const slot = nextSpawnSlot(room);
    // Reuse the client's own last real Spawn payload as the base instead of
    // an all-zero one: whatever lives in fields 0-6 (never decoded - team
    // and/or class selection, going by the symptom this fixed) is something
    // the client picked, not something we can safely default to 0 - a
    // synthetic all-zero payload was observed spawning team 1 players at
    // team 0's flag every time this timer fired.
    const payload = player.lastSpawnPayload ? [...player.lastSpawnPayload] : padded([], 10);
    applySpawnTestOverrides(room, player, payload);
    payload[7] = slot;
    payload[8] = slot;
    payload[9] = slot;

    const sockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
    broadcastPacket(sockets, XOR.external, GAME_PACKET, [1, player.slot, room.id, 2, SUB.SPAWN, ...payload]);
  }, AUTO_RESPAWN_MS);
}

// Ported from Handlers/Game/Ingame/WeaponSwitch.cs - records which weapon
// the player is currently holding (payload[2], a weapon id) and echoes it
// to the room so everyone's client shows the right model in the player's
// hands. No validation against the player's actual loadout (the reference
// doesn't either - it's client-authoritative same as movement/aim).
function handleWeaponSwitch(room, player, payload) {
  if (room.state !== 2) return null;
  player.weapon = Number(payload[2]) || 0;
  return { payload };
}

// Ported from Handlers/Game/Ingame/AmmoRecharge.cs - a reload ack, no state
// to update (no per-weapon ammo counts tracked here).
function handleAmmoRecharge(room, player) {
  if (room.state !== 2 || !player.alive) return null;
  return {};
}

// Ported from Handlers/Game/Ingame/Suicide.cs. The reference disables this
// outright in FFA/Explosive rooms (Room.Mode checks). A suicide is a death
// with no killer - no kill credited to anyone and no ticket pool touched
// (TeamDeathMatch.OnPlayerSuicide is a separate hook from OnDeath), so it
// can't trigger checkWinCondition on its own.
function handleSuicide(room, player, payload, u, db) {
  if (room.state !== 2 || !player.alive || room.mode === FFA_MODE || room.mode === 0) return null;

  player.health = 0;
  player.alive = false;
  player.deaths += 1;
  db.query('UPDATE user_details SET deaths = deaths + 1 WHERE id = ?', [player.userId]).catch((err) =>
    console.error('Suicide: failed to persist death:', err.message)
  );

  const out = [...payload];
  out[2] = player.slot;
  out[3] = 0;
  return { payload: out };
}

// Ported from Handlers/Game/Ingame/BackToLobby.cs. The client waits for this
// echo before dismissing the end-game results screen - returning null here
// (as if it were fire-and-forget like ConfirmSpawn/ConfirmDeath) left both
// players stuck staring at the results screen even though the round had
// already ended correctly server-side. ponytail: skips the reference's
// "refresh the lobby's room/user list once *everyone* is back" step -
// endRound() already did that the moment the round ended.
function handleBackToLobby(room, player, payload) {
  if (room.state !== 1 || player.inLobby) return null;
  player.inLobby = true;
  return { payload, selfTarget: true };
}

// Ported from Handlers/Scoreboard.cs + Packets/Scoreboard.cs. A top-level
// packet (not a GameSub - the client sends it directly, empty, whenever the
// in-match scoreboard is opened/refreshed - e.g. holding Tab), which is why
// it lived outside handleGamePacket's dispatch and got silently dropped
// until now (real capture: `id=30032 blocks=[]` firing repeatedly while Tab
// was held, never answered). Answered only while actually in a Playing
// room, matching the reference's guard.
//
// `Assists + Points` (position 5 of each player row) was sent as 0 - live
// test showed the client rendering a negative "assist" from that. Neither
// reference actually sends a hardcoded 0 there either (old: `Assists +
// Points` combined; ToXiiC-Core: separate Points then a literal 1 for
// Assist) - ponytail: no real assist tracking here, same "points ≈ kills"
// simplification EndGame already uses.
//
// Confirmed via 3 live data points the displayed value is `-4×kills -
// 1×deaths`, computed by the client from the kills/deaths it already gets
// correctly (not from this field, which stayed 0 throughout, or
// distinguishably from Points either). Client-side UI placeholder, not
// something any packet field can turn off - kept the Points=kills value
// anyway since it's still more faithful than a bare 0, but this isn't
// server-fixable.
function handleScoreboardRequest(socket) {
  const u = socket.user;
  if (!u || u.roomId === null) return;
  const room = getChannel(u.channel).rooms.get(u.roomId);
  if (!room || room.state !== 2) return;

  const [scoreA, scoreB] = scoreboardValues(room);
  const players = [...room.players.values()];
  const fields = [1, 0, 0, scoreA, scoreB, players.length];
  for (const p of players) fields.push(p.slot, p.kills, p.deaths, 0, p.kills, 0);
  socket.sendPacket(SCOREBOARD, fields);
}

// Ported from Handlers/Game/Ingame/RoundReady.cs - Explosive's per-round
// readiness ack (the Tab-key "get ready for the next round" ack, not the
// lobby Ready toggle). Clears the round-transition gate explosive.js's
// prepareRound() waits on (all players !roundWait). Fire-and-forget in the
// reference, no reply expected.
function handleRoundEndConfirm(room, player) {
  if (room.state !== 2) return null;
  player.roundWait = false;
  return null;
}

const HANDLERS = {
  [SUB.READY]: handleReady,
  [SUB.SIDE_UPDATE]: handleSideUpdate,
  [SUB.USER_LIMIT]: handleUserLimit,
  [SUB.START]: handleStart,
  [SUB.MAP_UPDATE]: settingHandler('map'),
  [SUB.MODE_UPDATE]: settingHandler('mode'),
  [SUB.CHANGE_ROUNDS]: settingHandler('setting'),
  [SUB.CHANGE_KILLS]: settingHandler('setting'),
  [SUB.PING_LIMIT]: settingHandler('pingLimit'),
  [SUB.GET_MISSION]: handleGetMission,
  [SUB.SPAWN]: handleSpawn,
  [SUB.CONFIRM_SPAWN]: handleConfirmSpawn,
  [SUB.PLAYER_DAMAGE]: handlePlayerDamage,
  [SUB.CONFIRM_DEATH]: handleConfirmDeath,
  [SUB.BACK_TO_LOBBY]: handleBackToLobby,
  [SUB.WEAPON_SWITCH]: handleWeaponSwitch,
  [SUB.AMMO_RECHARGE]: handleAmmoRecharge,
  [SUB.SUICIDE]: handleSuicide,
  [SUB.ROUND_END_CONFIRM]: handleRoundEndConfirm,
};

// Ported from Game/Networking/GameDataHandler.cs' shared envelope: every
// in-room action rides inside one packet id (GamePacket), with a 4-field
// header (sender slot, room id, an unidentified passthrough field, sub-type)
// followed by a sub-type-specific payload. The reply mirrors that shape and
// is normally broadcast to the whole room, sender included.
function handleGamePacket(socket, pkt, db) {
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
  const result = handler(room, player, payload, u, db);
  if (!result) return;

  const fields = [1, originalSlot, room.id, unknown, result.newType ?? subType, ...(result.payload ?? payload)];
  const sockets = result.selfTarget
    ? [socket]
    : [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
  broadcastPacket(sockets, XOR.external, GAME_PACKET, fields);

  if (result.updateLobby) sendRoomUpdateToLobby(room, true);
}

module.exports = { handleGamePacket, GAME_PACKET, handleScoreboardRequest, SCOREBOARD };
