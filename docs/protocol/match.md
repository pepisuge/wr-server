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
- `payload[2]` selects team **and** spawn point; the value-to-point mapping is not stable between sessions. `9` locked a client in a respawn loop.
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

The toggle (GameSub 62) is ported. Neither reference ever reads the flag to start a match. The native countdown `GameCountDown` (30001) works (the client even prints "Starting the game 0!"), but no tested packet completes the transition; at zero the master is asked to press Start.

## Minor subtypes

- `WeaponSwitch` (155): current weapon at `payload[2]`, rebroadcast; arrives in pairs. Not validated against inventory.
- `AmmoRecharge` (105): ack only; never observed.
- `Suicide` (157): death without a killer; never triggered from the UI.
- `GetMission`/`RoomReady` (402): "map loaded, give me the initial snapshot"; replies to the caller only.
- `MODE_UPDATE` (52): value at `payload[0]`, not `payload[2]`.

## Combat

### `PlayerDamage` (GameSub 103)

Carries the target slot, a `boneId` and the **weapon code** at `payload[22]`. On the killing hit the same packet is re-sent as `PlayerDeath` (152).

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

### Death and friendly fire

- On death: `alive=false`, `deaths++`, `kills++` for the attacker, persisted fire-and-forget.
- Can damage when `attacker.team != victim.team || room.friendlyFire || mode == FFA`.
- A friendly-fire kill penalizes the shooter (`kills--`, `deaths++`).

### Client-side behaviours

- The client leaves the room by itself after about **115 s** without input (anti-AFK timer).
- The respawn countdown shown after death is purely client-side.
