const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { getChannel, users } = require('./state');
const { sendRoomUpdateToLobby, findFreeSlot } = require('./rooms');
const { startRoundTimer, checkWinCondition, endRound, scoreboardValues } = require('./roundtimer');
const { getMap } = require('./maps');
const { initExplosiveMatch } = require('./explosive');
const { broadcastSystemMessage } = require('./chat');
const { getItem, codeById } = require('./items');
const { record } = require('./record');

const GAME_PACKET = 0x7530;
const SCOREBOARD = 0x7550;
// Game/Enums/Packets.cs's GameCountDown - exists in the reference but is
// dead code there (Packets/CountDown.cs ignores its own `seconds` parameter
// and always appends a literal 0, no caller anywhere in either reference).
// Not a port: an experiment to see whether the real client reacts to this
// opcode with a native countdown UI, since three attempts at triggering a
// match via GAME_PACKET/START_REPLY alone (instant, after a chat countdown,
// with a correctly-padded payload) all left the server in a real Playing
// state with zero visible client reaction.
const GAME_COUNTDOWN = 0x7531;

// Game/Enums/Mode.cs - only the three modes actually implemented here.
const EXPLOSIVE_MODE = 0;
const FFA_MODE = 1;
const TDM_MODE = 2;

// Modes/TeamDeathMatch.cs's Constants.TDMTickets, indexed by room.setting.
const TDM_TICKETS = [30, 50, 100, 150, 200, 300];

// GameConfig.MaxTeamDifference's compiled-in default (Game/GameConfig.cs) -
// how unbalanced the two teams may be for a team-based mode to start. FFA
// has no teams so it's exempt (matches Start.cs's `Room.Mode == Free_For_All`
// escape hatch).
const MAX_TEAM_DIFFERENCE = 1;

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
  AUTO_START: 62,
  PING_LIMIT: 59,
  SPAWN: 150,
  GET_MISSION: 402,
  START_MISSION: 403,
  PLAYER_DAMAGE: 103,
  PLAYER_DEATH: 152,
  HEAL: 101,
  ENVIRONMENT_DAMAGE: 500,
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
  return { payload: out, checkAutoStart: true };
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
  return { payload: out, checkAutoStart: true };
}

// Same "can this room start a match right now" check Start.cs gates on:
// everyone ready, at least 2 players, teams balanced within
// MAX_TEAM_DIFFERENCE for team-based modes (a room where every player sits
// on the same team, e.g. Explosive/TDM, is exactly what this blocks - FFA
// has no teams and is exempt). Shared by the manual Start handler and the
// autostart trigger below.
function canStart(room) {
  const players = [...room.players.values()];
  if (!players.every((p) => p.ready) || players.length < 2) return false;
  if (room.mode !== FFA_MODE) {
    const team0 = players.filter((p) => p.team === 0).length;
    const team1 = players.filter((p) => p.team === 1).length;
    if (Math.abs(team0 - team1) > MAX_TEAM_DIFFERENCE) return false;
  }
  return true;
}

// The state mutation that actually begins a match, shared by the manual
// Start handler and the autostart trigger - ported from Room.Start()/
// TeamDeathMatch.Initilize. Doesn't actually load a map (no MapManager yet)
// - just flips the room to Playing so the client moves on.
function beginMatch(room, db) {
  const players = [...room.players.values()];
  // Fresh round: clear last round's health/kills/deaths (Player.Reset/RoundStart).
  for (const p of players) {
    p.health = 1000;
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
}

// Ported from Game/Handlers/Game/Lobby/Start.cs. Skips the AccessLevel/
// AllowStartAlone override.
function handleStart(room, player, payload, u, db) {
  if (player.slot !== room.master || room.state !== 1) return null;
  if (!canStart(room)) return null;
  beginMatch(room, db);
  const out = [...payload];
  out[2] = room.map;
  return { newType: SUB.START_REPLY, payload: out, updateLobby: true };
}

// New work, not a port: neither C# reference has any logic that reads
// AutoStart/autostart to actually trigger a match (write-only in both, same
// as EnableVoteKick). Domain knowledge from live testing filled part of the
// gap the references don't cover: the real feature shows a countdown in the
// room chat once conditions are met. AUTOSTART_COUNTDOWN_SECONDS is a
// best-guess (user's memory placed it "between 18 and 20s", not from either
// reference or a packet capture) - adjust once seen on the wire.
//
// Three separate live tests of "fire a server-pushed START_REPLY once
// conditions are met" all showed the same result: the server moved to a
// real Playing state (map, tickets, GameTick ticking for 80-130+ seconds)
// while the client showed zero reaction on any screen - not instantly, not
// after a real chat countdown, not even with the payload padded to match a
// real client's own 10-field GamePacket length (ruling out "packet just too
// short to parse" as the cause).
//
// What did change something: GAME_COUNTDOWN (0x7531) - dead code in the
// reference (Packets/CountDown.cs ignores its own `seconds` parameter, no
// caller anywhere), tried anyway as an experiment - turned out to render a
// real native countdown in the client's chat UI, confirmed live. Still, by
// itself, reaching 0 didn't cause the client to send its own Start. Fourth
// attempt (see tryAutoStart below): send the real START_REPLY together with
// GAME_COUNTDOWN's final 0 tick, a combination not tried before - if this
// still doesn't work, the honest conclusion is that a true zero-click start
// isn't achievable with what's known about this client's protocol, and the
// countdown should go back to ending in a "press Start" nudge instead of
// risking another desynced Playing state.
const AUTOSTART_COUNTDOWN_SECONDS = 20;

// Re-checks canStart() every tick so a player un-readying or unbalancing the
// teams mid-countdown cancels it instead of starting a match nobody agreed
// to anymore. Self-cleans if the room empties out too (canStart requires 2+
// players), no separate teardown wired to room deletion needed.
function tryAutoStart(room) {
  if (room.autoStartCountdown) return; // already counting down
  if (!room.autoStart || room.state !== 1 || !canStart(room)) return;

  // Broadcasts GAME_COUNTDOWN alongside the chat line each tick - see the
  // opcode's own comment above for why (unproven experiment, not a port).
  const sendCountdownPacket = (seconds) => {
    const sockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
    broadcastPacket(sockets, XOR.external, GAME_COUNTDOWN, [seconds]);
  };

  let remaining = AUTOSTART_COUNTDOWN_SECONDS;
  broadcastSystemMessage(room, `Avvio automatico tra ${remaining} secondi...`);
  sendCountdownPacket(remaining);
  room.autoStartCountdown = setInterval(() => {
    if (!room.autoStart || room.state !== 1 || !canStart(room)) {
      clearInterval(room.autoStartCountdown);
      room.autoStartCountdown = null;
      broadcastSystemMessage(room, 'Avvio automatico annullato.');
      sendCountdownPacket(0);
      return;
    }
    remaining--;
    if (remaining <= 0) {
      clearInterval(room.autoStartCountdown);
      room.autoStartCountdown = null;
      // Fourth attempt (send the real START_REPLY together with
      // GAME_COUNTDOWN's final 0 tick) also failed live: the client's native
      // countdown UI genuinely reacts now - it shows its own hardcoded
      // string "Starting the game 0!" at zero, proving it's watching this
      // opcode and expects a match to begin - but the match still didn't
      // start. Stopping here: four different combinations tried (instant,
      // after a chat countdown, with a correctly-padded payload, paired with
      // the native GAME_COUNTDOWN reaching 0) all end the same way, and
      // guessing further risks the same "ghost match" desync each earlier
      // attempt produced. beginMatch/START_REPLY is not fired automatically
      // - only a real click on Start (handleStart above) is confirmed to
      // work. GAME_COUNTDOWN is kept for the real, confirmed-working native
      // countdown UI; what completes the transition at 0, if anything short
      // of a real click can, is unknown.
      sendCountdownPacket(0);
      broadcastSystemMessage(room, 'Tempo scaduto! Il master deve premere Start per iniziare.');
      return;
    }
    broadcastSystemMessage(room, String(remaining));
    sendCountdownPacket(remaining);
  }, 1000);
}

// Ported from Handlers/Game/Lobby/ToggleAutostart.cs (GameSubs.Autostart=62,
// WarRock-Chapter-1-Server - the only one of the two references where this
// toggle actually works; WarRock-ToXiiC-Core registers the same opcode but
// its handler never touches the field). Host-only, only while Waiting, flips
// room.autoStart and echoes the new state in payload[2]. checkAutoStart
// covers turning it on when the room already meets the start conditions.
function handleAutoStart(room, player, payload) {
  if (player.slot !== room.master || room.state !== 1) return null;
  room.autoStart = !room.autoStart;
  const out = padded(payload, 3);
  out[2] = room.autoStart ? 1 : 0;
  if (!room.autoStart && room.autoStartCountdown) {
    clearInterval(room.autoStartCountdown);
    room.autoStartCountdown = null;
    broadcastSystemMessage(room, 'Avvio automatico annullato.');
  }
  return { payload: out, updateLobby: true, checkAutoStart: true };
}

// Ported from Game/Handlers/Game/{ChangeMap,ChangeSubMode,ChangePinglimit}.cs.
// All three are the same shape: master-only, room still Waiting, apply
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

// Ported from Game/Handlers/Game/Lobby/ChangeMode.cs's Room.Mode assignment
// - but NOT its payload[2] read. A live capture of a real FFA-switch attempt
// showed payload[0]=1 (FFA's real Mode enum value) while payload[2] stayed 0
// (Explosive) - the room silently reverted to Explosive instead of
// switching. Same flavor as this session's RoomKick/RoomInvite field-offset
// finds: this client just doesn't put the value where the reference does
// for this one sub. The other three settingHandler subs aren't touched -
// no evidence they're wrong, only this one was observed failing live.
function handleModeUpdate(room, player, payload) {
  if (player.slot !== room.master || room.state !== 1) return null;
  const mode = Number(payload[0]);
  if (![EXPLOSIVE_MODE, FFA_MODE, TDM_MODE].includes(mode)) return null;
  room.mode = mode;
  return { payload, updateLobby: true };
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
  player.health = 1000; // covers first spawn and every respawn after a death - Entities/Player.cs's Health=1000, not 100 (confirmed in both references, not Explosive-specific)
  player.alive = true;
  // Spawn.cs's GetByte(3): the class the client just spawned as (Engineer=0,
  // Medic=1, Sniper=2, Assault=3, Heavy=4). Only used for the room roster's
  // class field for now - a player who joins mid-match otherwise shows as
  // Engineer to everyone until they spawn once.
  player.class = Number(payload[3]) || 0;
  record({ e: 'spawn', slot: player.slot });
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
// Real per-weapon damage: `item_target_info.power` (DB table, confirmed
// populated - e.g. DA02=200, DG05=850, DL01=2000) x a weapon-independent
// hitbox multiplier (DB table `damage_multipliers`: head 1.5, torso 0.75,
// lower limbs 0.33, sniper-zone 1.5 - GameMode.cs's GetHitBoxMultiplier).
// Kills/deaths persist to user_details immediately (fire-and-forget, same
// pattern as checkPremiumExpiry).
//
// The reference also applies a distance-falloff tier (Weapon.PowerPersonal,
// "Low/Middle/High") on top of this, but the 23-field damage payload handled
// below has no distance/radius field to key it off of - always uses the
// closest tier (index 0). Confirmed against the full client catalog
// (Data/items.bin, TARGET_INFO.PERSONAL - guide 17.5): index 0 is 100 for
// nearly all guns, but not for knives/rockets (DJ/DK, 70-90) or vehicle-
// mounted weapons (FB/FC/FD, 50-90) - PERSONAL_FALLOFF below holds only the
// exceptions, everything else defaults to 1 (100%). Upgrade to the full
// Low/Middle/High tiers if a distance field is ever identified in the
// payload.
const PERSONAL_FALLOFF = {
  DJ01: 0.75, DJ02: 0.9, DJ03: 0.75, DJ04: 0.9, DK01: 0.7, DK02: 0.9,
  DL01: 0.5, DL02: 0, DO01: 0, DO02: 0, DO03: 0, DP02: 0, DQ01: 0, DQ02: 0,
  DQ03: 0, DR01: 0, DR02: 0, DS01: 0, DS02: 0, DS03: 0, DS05: 0, DU01: 0,
  DV01: 0, DW02: 0, DW03: 0, DW04: 0, DX01: 0, DX02: 0, FA01: 0, FB01: 0.55,
  FB03: 0.9, FB04: 0.9, FC01: 0.55, FC02: 0.5, FC03: 0.5, FD01: 0.7, FI02: 0.7,
};
//
// Only the true head zone (1237) counts as a real headshot (icon/stat) -
// the reference excludes knives/rockets even on a head hit (`GameMode.cs`:
// weapon code not DA/DJ/DK), and the sniper zone (1243) does the same x1.5
// damage as a headshot without being flagged as one at all.
const HITBOX_MULTIPLIER = {
  1237: 1.5, // head/neck
  1239: 0.75, // torso/limbs
  1241: 0.33, // lower limbs
  1243: 1.5, // sniper-only bone, same multiplier as a headshot but not one
};
const FALLBACK_POWER = 25; // unknown/uncatalogued weapon code - old flat baseline
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
  const basePower = getItem(weapon)?.power || FALLBACK_POWER;
  const falloff = PERSONAL_FALLOFF[weapon] ?? 1;
  const damage = Math.round(basePower * falloff * (HITBOX_MULTIPLIER[hsCalc] ?? 0.75));

  const previousHealth = victim.health;
  victim.health = Math.max(0, victim.health - damage);
  record({ e: 'hit', from: player.slot, to: victim.slot, bone: hsCalc, weapon, dmg: damage, hs: headshot, hp: victim.health });

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
    u.kills = Math.max(0, u.kills - 1);
    u.deaths += 1;
    db.query('UPDATE user_details SET deaths = deaths + 1, kills = GREATEST(0, CAST(kills AS SIGNED) - 1) WHERE id = ?', [
      player.userId,
    ]).catch((err) => console.error('PlayerDamage: failed to persist friendly-fire penalty:', err.message));
    return { newType: SUB.PLAYER_DEATH, payload: out };
  }

  victim.deaths += 1;
  player.kills += 1;
  // RoomPlayers.cs's roster field is the ACCOUNT's lifetime kills/deaths
  // (User.Kills), not this room's match tally - mirror the same increment
  // onto the account object kept in `users` so the lobby tooltip (which
  // reads this, not `player.kills`/`player.deaths`) doesn't sit at 0 until
  // the next login re-reads the DB.
  const victimUser = users.get(victim.sessionId);
  if (victimUser) victimUser.deaths += 1;
  u.kills += 1;
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

    player.health = 1000;
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
// A death with no killer (also what lethal environment damage ends in): deaths+1, persisted.
function suicideDeath(player, u, db) {
  player.health = 0;
  player.alive = false;
  player.deaths += 1;
  u.deaths += 1;
  db.query('UPDATE user_details SET deaths = deaths + 1 WHERE id = ?', [player.userId]).catch((err) =>
    console.error('Suicide: failed to persist death:', err.message)
  );
}

function handleSuicide(room, player, payload, u, db) {
  if (room.state !== 2 || !player.alive || room.mode === FFA_MODE || room.mode === 0) return null;

  suicideDeath(player, u, db);
  const out = [...payload];
  out[2] = player.slot;
  out[3] = 0;
  return { payload: out };
}

// Ported from Handlers/Game/Ingame/EnvironmentDamage.cs: damage from world physics (falls, water, leaving the playable
// zone), reported by the client itself. payload[2] entity type (1 = player, 0 = vehicle), [5] damage. A lethal hit is
// broadcast as a Suicide (157) with the slot in [2], like the reference. Vehicle damage is skipped: no vehicles yet.
function handleEnvironmentDamage(room, player, payload, u, db) {
  if (room.state !== 2 || !player.alive || Number(payload[2]) !== 1) return null;
  const damage = Number(payload[5]);
  if (!(damage > 0)) return null;

  const out = [...payload];
  out[7] = damage;
  if (player.health > damage) {
    player.health -= damage;
    out[8] = player.health;
    return { payload: out };
  }
  suicideDeath(player, u, db);
  out[2] = player.slot;
  out[8] = 0;
  return { newType: SUB.SUICIDE, payload: out };
}

// Ported from Handlers/Game/Ingame/Heal.cs. payload[2] target slot, [3] 1 = healing tower. Amount by the healer's
// weapon: medic kits 300/450/600, HP kit 200, adrenaline tops up to 400 (else +100), tower 400. Same team only; the
// reference's assist counter is not tracked here. Items are matched by code (their numeric ids differ between patches).
const HEAL_KIT = { DQ01: 300, DQ02: 450, DQ03: 600, DS10: 200 };
function handleHeal(room, player, payload) {
  if (room.state !== 2 || !player.alive) return null;
  let target = [...room.players.values()].find((p) => p.slot === Number(payload[2]));
  if (!target || target.health >= 1000 || target.team !== player.team) return null;
  if (room.mode === FFA_MODE) target = player;

  const code = codeById(player.weapon);
  let amount;
  if (Number(payload[3]) === 1) amount = 400;
  else if (code === 'DS01') amount = target.health < 400 ? 400 - target.health : 100;
  else amount = HEAL_KIT[code] ?? 0;

  target.health = Math.min(1000, target.health + amount);
  const out = [...payload];
  out[3] = target.health;
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
  [SUB.AUTO_START]: handleAutoStart,
  [SUB.START]: handleStart,
  [SUB.MAP_UPDATE]: settingHandler('map'),
  [SUB.MODE_UPDATE]: handleModeUpdate,
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
  [SUB.HEAL]: handleHeal,
  [SUB.ENVIRONMENT_DAMAGE]: handleEnvironmentDamage,
  [SUB.ROUND_END_CONFIRM]: handleRoundEndConfirm,
};

// Ported from Game/Networking/GameDataHandler.cs' shared envelope: every
// in-room action rides inside one packet id (GamePacket), with a 4-field
// header (sender slot, room id, an unidentified passthrough field, sub-type)
// followed by a sub-type-specific payload. The reply mirrors that shape and
// is normally broadcast to the whole room, sender included.
const unhandledSeen = new Set();
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
  if (!handler) {
    // unrecognized/out-of-scope sub-type: ignored (Fase 4's GamePacket note), but logged once so its real format is visible
    if (!unhandledSeen.has(subType)) { unhandledSeen.add(subType); console.log(`[game] unhandled sub ${subType} payload=[${payload.join(', ')}]`); }
    return;
  }

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
  if (result.checkAutoStart) tryAutoStart(room);
}

module.exports = { handleGamePacket, GAME_PACKET, handleScoreboardRequest, SCOREBOARD, HANDLERS, SUB };
