---
layout: page
title: Match flow and combat
permalink: /protocol/match
---

## Modes

`room.mode` follows the C# enum: `0` Explosive, `1` FFA, `2` TDM, `3` Conquest (not implemented).

| mode | win condition | spawn | friendly fire |
|---|---|---|---|
| FFA (1) | first to `10 + 5 x setting` kills, or last player standing | shared round-robin 0-19 | always on |
| TDM (2) | a team's ticket pool runs out (or a team is empty); more tickets wins | chosen by the client | off unless `room.friendlyFire` |
| Explosive (0) | first to `[1,3,5,7,9][setting]` rounds | chosen by the client | off unless `room.friendlyFire` |

TDM tickets: `[30, 50, 100, 150, 200, 300][setting]`. A normal kill decrements the **victim's** team pool; a friendly-fire kill touches no pool.

## Start: `START` (GameSub 1) -> `START_REPLY` (GameSub 4)

Requires everyone ready, at least 2 players and, outside FFA, balanced teams (difference at most 1). Otherwise there is **no reply**.

After start the client shows class/weapon selection, sent as `Equipment` (29970, top-level).

## `GameTick` (30016): the heartbeat

Sent **once per second**. Without it the client never considers the match started and never asks to spawn.

```
OUT(broadcast) id=30016 fields=[20000, 3580000, 0, 0, 0, 0, 2, 0, 30]
IN  id=30000 blocks=[..., 150, ...]      <- client asks to spawn
OUT(broadcast) id=30000 fields=[1, 0, 1, 2, 150, ...]
```

It also carries `ScoreboardA/B` (in FFA: target kills and the leader's kills).

## Spawn (GameSub 150)

- `payload[3]` is the **class**, valid `0-4` (`Engineer, Medic, Sniper, Assault, Heavy`). An out-of-range value crashes other clients.
- `payload[2]` selects team **and** spawn point; the value-to-point mapping is not stable between sessions. `9` locked a client in a respawn loop. The spawn index the server answers with changes nothing in TDM (live: per-team and shared round-robins, -2, -1, 2, 10 all landed on the same per-team point), so only FFA gets a round-robin, like the reference.
- Spawning is always **client-initiated** in both references. In TDM the client asks to respawn about **19 s** after death; the server safety-net auto-respawn is set to 25 s, reusing the player's last real spawn payload.
- FFA uses a shared round-robin counter 0-19, reset every round.
- `map_data` gives each map a `flag_count` and a `flag_state` `"X-Y"`: the two spawn-anchor flags, one per team.

## End of round: `EndGame` (30048)

Top-level packet. Carries XP and money earned per player (persisted).

```
[OK, CurrentRoundTeamA, CurrentRoundTeamB, killsDerb, deathsDerb, killsNIU, deathsNIU, 0, 0, playerCount, ...]
```

The win/lose banner reads `CurrentRoundTeamA/B` at **positions 1-2**. In FFA every player gets a loss (the reference's `Winner()` always returns `None`).

- `BackToLobby` (GameSub 9) **must be echoed** to the sender, or the client stays stuck on the results screen.
- `ConfirmDeath` (GameSub 154) **must be echoed**, or the client leaves the room after a few seconds.

## Explosive

Ported from `Modes/Explosive.cs`, magic constants copied verbatim. Subtypes: `START_MISSION` (403), `START_ROUND` (5), `END_ROUND` (6), `ROUND_END_CONFIRM` (7). `EXPLOSIVES` (29984) is top-level. The round counter is incremented **before** the win check (`>=`).

## Scoreboard (30032): the Tab key

Top-level. The client repeats `id=30032 blocks=[]` while Tab is held. The reply (only in a `Playing` room) has the `GameTick` scoreboard values plus one row per player: `slot, kills, deaths, flags, assists+points, 0`. The "assist" column is computed by the client as `-4 x kills - 1 x deaths` and cannot be driven by the server.

## Autostart

The toggle (GameSub 62) is ported; neither reference ever reads the flag. Once everyone is ready (same checks as Start) the server sends `GameCountDown` (30001) `[seconds]` once per second from 20. The client handler (`FUN_005f2790`) only prints text ("Game starts in 20 seconds", a reminder every 5 s, "Starting the game N !"): it never starts anything itself. At 0 the server starts the match and broadcasts the same reply a real Start gets:

```
OUT(broadcast) id=30000 fields=[1, master slot, room id, 1, 4, 1, 0, map, 0, 0, 0, 0, 0, 0, 0]
```

The header type (4th field) must be **1** (room): the client routes type 2 to the in-match handler, and earlier attempts that sent type 2 left the room "Playing" with no client in a match. Un-readying, unbalancing the teams or switching autostart off cancels the countdown.

## Votekick

GameSub 61, header type 2 (`game/votekick.js`). Protocol from WarRock-ToXiiC-Core, checked against client 22 (`FUN_004e45a0` handler, `FUN_005e4140` HUD, Y/N keys in `FUN_005dcf..`):

| Direction | `payload[2]` | Other fields | Meaning |
|---|---|---|---|
| C -> S | 0 | `[3]` target slot | request, captured: `[0, 0, 2, 61, 1, 0, 0, 3, 0, ...]` |
| S -> target's team | 1 | `[3]` target, `[6]` requester | vote open: "X has requested to votekick Y", 30 s, [Y]/[N] |
| C -> S | 1 | `[3]` target | **Y** pressed. **N** sends nothing, so every vote received is a yes |
| S -> target's team | 2 | `[3]` target, `[5]` | result: `[5] >= 80` shows "has been kicked" (the reference's 75 would show "was not kicked" on this client) |

Rules (reference): same team only, not FFA, the team has 4+ players, one vote at a time, a majority of the target's team (target included), 60 s between votes, the kicked player cannot rejoin the room for 5 minutes. Errors are a bare `GAME_PACKET` `[code]`: 96150 in progress, 96151 cannot now, 96152 invalid candidate, 96153 opposing team, 96154 need 4 players. The kick itself is the master-kick notice (`ROOM_KICK`), after which the client leaves on its own.

## Minor subtypes

- `WeaponSwitch` (155): current weapon at `payload[2]`, rebroadcast; arrives in pairs. Not validated against inventory.
- `AmmoRecharge` (105): ack only; never observed.
- `Suicide` (157): death without a killer; never triggered from the UI.
- `GetMission`/`RoomReady` (402): "map loaded, give me the initial snapshot"; replies to the caller only.
- `MODE_UPDATE` (52): value at `payload[0]`, not `payload[2]`.

## Combat

### `PlayerDamage` (GameSub 103)

Carries the target slot, a `boneId` and the **weapon code** at `payload[22]`. On the killing hit the same packet is re-sent as `PlayerDeath` (152).

### Hit validation

The client decides what it hit, where and with which weapon; the server only checks what it can and silently drops the hit otherwise (`[anticheat]` log line):

- the weapon (`payload[22]`) must be in the attacker's loadout for the class it spawned as (`Spawn` `payload[3]`);
- at most 20 hits per second per attacker (the DB has no fire rates; the fastest real gun recorded lands ~1 hit every 85 ms, knife ~860 ms);
- knife (`DA*`) hits need the two players within 1500 units, using their last `0x31` frame positions (skipped if either is older than 1 s). Frame positions lag what the client draws: real knife hits on a moving target were recorded up to 860 units apart, on maps ~20000 wide, so this only stops cross-map knifing.

`payload[4]` is the **attacker slot** (the kill feed shows that player's name); the server overwrites it with the sender's slot. Hitbox (head/body) and the victim are still the client's word: an aimbot is not detectable this way.

### Damage formula

```
damage = round(Power x PowerPersonal[0]/100 x radius/100 x hitboxMultiplier)
```

`Power` comes from `item_target_info`. The damage packet has no identified distance field, so the nearest falloff tier (index 0) is always used; exceptions (knives/launchers 70-90%, vehicle weapons 50-90%, 0 for non-damaging items) are in `PERSONAL_FALLOFF` (`gamesubs.js`).

### Hitboxes

Zone = `boneId - attacker sessionId`.

| value | zone | multiplier | note |
|---|---|---|---|
| 1237 | head/neck | x1.5 | headshot (icon + stat) |
| 1239 | torso/arms | x0.75 | |
| 1241 | lower limbs | x0.33 | |
| 1243 | sniper bone | x1.5 | not counted as a headshot |

Knives and rockets (`DA`/`DJ`/`DK`) never count as headshots. The headshot flag (`shootenPart`) is at payload index **17** for this client (18 is for newer Nexon clients).

### Health is 1000, not 100

Every player starts at `health = 1000` in all modes (confirmed in both references).

### Bleeding

Server-side, ported from ToXiiC's room thread: client 22 does not bleed by itself (live). Every 10 s an alive player under 300 HP loses 5 (25 on channel 2), unless they own the compressed bandage `CH01`. The new health goes out silently in `ROOM_HEALTH` (`0x7541` = 30017, ToXiiC's `SP_RoomInitializeUsers`), client 22 layout (`FUN_005f3cc0`): `[n, (slot, health, vehicle, seat) x n, vehicles, vehicle health x vehicles]` (no extra `-1` per player as in ToXiiC's later chapters). Environment damage (sub 500) also sets the health (`payload[8]`) but always prints a message by `payload[3]`: `2` = " damage from falling" (`m67`), `4` = " damage from shock" (`m68`), anything else "Damage from (ASSERT)" (`m69`) (live, `FUN_004de150`). The client shows the bleeding warning itself on that packet for a player between 1 and 299 HP: red `m34` without `CH01`, white `m986_6` "You are using compressed bandage." with it, so it goes out every 10 s while anyone is under 300, bandaged players included (as in ToXiiC). Bleeding out is a Suicide (157) with type 1 in `payload[1]` (ToXiiC: "killed by not having heal treatment"). Verified live: health drops (the HUD shows percent, so -5 is one point every ~20 s), bleeding out kills, `CH01` stops it.

### Death and friendly fire

- On death: `alive=false`, `deaths++`, `kills++` for the attacker, persisted fire-and-forget.
- Can damage when `attacker.team != victim.team || room.friendlyFire || mode == FFA`.
- A friendly-fire kill penalizes the shooter (`kills--`, `deaths++`).

### Vehicles (GameSubs 200-202, 102, 104, 151, 153)

`node/game/vehicles.js` loads `vehicletypes` (health, respawn interval, kind 1 surface / 2 air / 3 ship), `vehicleseats`
(weapons and ammo per seat), `vehicleweapons` (damage, efficiency % vs personal/surface/air/ship) and `map_vehicles`
(the map's own vehicle ids, the ones the client sends). A fresh set is created at every match start.
Layouts from ToXiiC's G1 handlers (its block n = `payload[n-4]`), checks from the Chapter-1 reference:

- EnterVehicle 200: `[2]` vehicle id (real client 22: `[0, 0, 26, 0 x7]`). Reply `[2]` id, `[3]` seat, `[4]` health, `[5]` max, `[6..9]` seat ammo. Only the team inside (or anyone if empty).
- ChangeSeat 201: `[2]` id, `[3]` target seat, `[4..7]` ammo of the old seat. Reply `[3]` new, `[4]` old seat, `[5..8]` ammo of the new seat.
- LeaveVehicle 202: `[2]` id, `[4..7]` ammo kept for the seat. Reply `[3]` seat.
- Repair 102: `[2]` id, `[3]` 1 = repair tower (20%); spanner DR01 10%, pipe wrench DR02 15%; one every 2 s. Reply `[3]` health, `[4]` max.
- ObjectDamage 104: `[2]` 1 personal weapon / 0 vehicle weapon or artillery, `[3]` vehicle id, `[9]` 0 main / 1 sub weapon, `[10]`=1 and `[11]` radius %, `[22]` weapon (or the attacker's vehicle code). Client 22 also sends `[5]` = the attacker's own vehicle id when shooting from one (live: 8 from a K1A1; junk on foot). Damage = power x efficiency % (item `surface/air/ship`, or the vehicle weapon's list) x radius %. Reply `[4]` attacker slot, `[12]` health, `[13]` previous.
- At 0 health: each crew member gets a PlayerDeath (152), then ObjectDestroy 153 (ToXiiC's explode packet without its Nexon-only field), then VehicleSpawn 151 after the interval.
- PlayerDamage 103 with `[2]` = 0 is a vehicle weapon (the attacker's seat weapon, `[22]` = vehicle code) or artillery (needs DX01).
- ROOM_HEALTH 0x7541 now carries each player's vehicle/seat and every vehicle's health.

Live-tested on client 22 (Havana, one player): enter, seat changes with ammo, leave, damage from a tank's cannon/MG and from RPG/launchers on foot, destruction, respawn. Not yet live: repair, vehicle weapons on players, crew killed with the vehicle.

### Client-side behaviours

- The client leaves the room by itself after about **115 s** without input (anti-AFK timer).
- The respawn countdown shown after death is purely client-side.
