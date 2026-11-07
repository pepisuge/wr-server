---
layout: page
title: Opcode tables and constants
permalink: /protocol/reference
---

## TCP opcodes: login channel (5330)

| hex | dec | name | direction |
|---|---|---|---|
| `0x1010` | 4112 | `LAUNCHER` (patch check) | both |
| `0x1100` | 4352 | `SERVER_LIST` (login -> server list) | both |
| `0x1200` | 4608 | `CONNECTION` (greeting) | S->C |

## TCP opcodes: internal Auth <-> Game (5012)

| hex | dec | name | direction |
|---|---|---|---|
| `0x1200` | 4608 | `CONNECTION` | Auth->Game |
| `0x1000` | 4096 | `AUTHORIZATION` (server registration / confirm) | both |

## TCP opcodes: game channel (5340)

| hex | dec | name | direction |
|---|---|---|---|
| `0x1200` | 4608 | `CONNECTION` | S->C |
| `0x6100` | 24832 | `SERVER_TIME` (+ MAC check) | both |
| `0x6200` | 25088 | `AUTHORIZATION` (game) | both |
| `0x6400` | 25600 | `PING` (premium countdown + liveness) | both |
| `0x6710` | 26384 | `CLAN_SYSTEM` | both |
| `0x6760` | 26464 | `CLAN_RANKING` | both |
| `0x7001` | 28673 | `CHANNEL_SELECTION` | both |
| `0x7100` | 28928 | `USER_LIST` | both (+ push) |
| `0x7110` | 28944 | `USER_LIST_MODIFY`: never implemented by either side | - |
| `0x7200` | 29184 | `ROOM_LIST` | both |
| `0x7210` | 29200 | `ROOM_LIST_UPDATE` | S->C |
| `0x7300` | 29440 | `ROOM_CREATION` | both |
| `0x7310` | 29456 | `ROOM_JOIN` | both |
| `0x7340` | 29504 | `ROOM_LEAVE` | both (+ broadcast) |
| `0x7341` | 29505 | `ROOM_KICK` | both |
| `0x7350` | 29520 | `ROOM_INVITE` | both |
| `0x7400` | 29696 | `CHAT` (also GM commands) | both |
| `0x7500` | 29952 | `PLAYER_INFO` (room roster) | S->C |
| `0x7512` | 29970 | `EQUIPMENT` | both |
| `0x7520` | 29984 | `EXPLOSIVES` (top-level) | S->C |
| `0x7530` | 30000 | `GAME_PACKET` (GameSub container) | both |
| `0x7531` | 30001 | `GAME_COUNTDOWN` (dead code in the C#, live in the client) | S->C |
| `0x7540` | 30016 | `GAME_TICK` (1/s heartbeat) | S->C |
| `0x7550` | 30032 | `SCOREBOARD` (Tab key, top-level) | both |
| `0x7560` | 30048 | `END_GAME` (top-level) | S->C |
| `0x7600` | 30208 | `ITEMSHOP` (purchase, item coupon reply) | both |
| `0x7920` | 31008 | `LEVEL_UP` | S->C |
| `0x8100` | 33024 | `COUPON` | both |

## GameSub: subtypes inside `GAME_PACKET` (30000)

Envelope: `[sender slot, room id, unidentified field, subtype, ...payload]`.

| dec | name | notes |
|---|---|---|
| 1 | `START` | master start request |
| 4 | `START_REPLY` | start confirmation, broadcast |
| 5 | `START_ROUND` | Explosive (unnamed in the enum) |
| 6 | `END_ROUND` | Explosive |
| 7 | `ROUND_END_CONFIRM` | Explosive |
| 9 | `BACK_TO_LOBBY` | **echo to sender required** |
| 50 | `READY` | |
| 51 | `MAP_UPDATE` | |
| 52 | `MODE_UPDATE` | value at `payload[0]` |
| 53 | `CHANGE_ROUNDS` | |
| 55 | `CHANGE_KILLS` | |
| 56 | `SIDE_UPDATE` | team change = slot change |
| 58 | `USER_LIMIT` | host entry lock |
| 59 | `PING_LIMIT` | |
| 62 | `AUTO_START` | toggle |
| 100 | `CONFIRM_SPAWN` | fire-and-forget |
| 103 | `PLAYER_DAMAGE` | weapon at `payload[22]`, headshot flag at index 17 |
| 105 | `AMMO_RECHARGE` | ack only |
| 150 | `SPAWN` | `payload[2]` team+point, `payload[3]` class 0-4 |
| 152 | `PLAYER_DEATH` | 103 promoted on the killing hit |
| 154 | `CONFIRM_DEATH` | **echo required** |
| 155 | `WEAPON_SWITCH` | weapon at `payload[2]` |
| 157 | `SUICIDE` | |
| 402 | `GET_MISSION` / RoomReady | replies to the caller only |
| 403 | `START_MISSION` | |

## UDP (5350/5351)

| field | value | meaning |
|---|---|---|
| type @0 | `0x1001` | `INITIAL` handshake on 5350; reply rewrites the port to 5351 |
| type @0 | `0x1010` | `PING`: NAT handshake and relay tunnel |
| sub @14 | `0x21` | handshake ping / NAT keepalive |
| sub @14 | `0x31` | movement (the only one observed) |
| sub @14 | `0x10`, `0x30`, `0x32`, `0x34` | tunnel, never observed |

## Error codes

| code | meaning |
|---|---|
| `72010` | unknown user |
| `72020` | wrong password |
| `73030` | invalid session |
| `73050` | account banned |
| `74010` / `74020` | empty username / password |
| `92040` | `IdInUse`: account or sessionId already online |
| `94060` | `UsersExceeded`: host locked the room |
| `94120` | `RoomIsFull` |
| `97010` / `97020` | invalid code / not buyable (incl. already owned) |
| `97040` | not enough money |
| `97060` | premium/level requirement not met |
| `97070` | inventory full (max 32) |
| `97090` | `AlreadyEquipped` |
| `62003` | clan name already exists |

## Game constants

| constant | value |
|---|---|
| starting health | **1000** |
| hitbox multipliers | head 1.5, torso 0.75, lower limbs 0.33, sniper bone 1.5 |
| TDM tickets | `[30, 50, 100, 150, 200, 300][setting]` |
| FFA kill target | `10 + 5 x setting` |
| Explosive rounds | `[1, 3, 5, 7, 9][setting]` |
| max team difference | 1 |
| FFA spawn round-robin | 0-19, shared, reset each round |
| auto-respawn safety net | 25000 ms (client asks after ~19 s) |
| ping / liveness timeout | every 5 s / 20 s |
| UDP keepalive | 60 s |
| presence batching | 750 ms |
| chat line limit | `MAX_CHAT_LINE = 50` (input box: 55) |
| client anti-AFK | ~115 s |
| clan creation cost | 10000 dinars |
| premium tiers | `0` F2P, `1` Bronze, `2` Silver, `3` Gold, `4` Platinum |
| classes | `0` Engineer, `1` Medic, `2` Sniper, `3` Assault, `4` Heavy |
| modes | `0` Explosive, `1` FFA, `2` TDM, `3` Conquest (not implemented) |
| free base weapons | `DA02, DB01, DF01, DG05, DC02, DJ01, DR01, DQ01, DN01, DL01` |

## Open problems

Good places to contribute:

- **Conquest** mode, **vehicles** and artillery (`ObjectDamage`).
- **Votekick**, item **renewal**, premium `cash` currency, `UseItem`/`RemoveItem` (stamina, HP kit effects).
- **Damage falloff by distance**: no distance field identified in `PlayerDamage`.
- **Autostart trigger**: the native countdown works, the transition does not.
- **Invisible scripted player** ([UDP](udp#open-problem-the-invisible-fake-player)).
- **Scoreboard assist column**: computed by the client, not drivable.
- **UDP movement offset 33**: unknown.
- **Invite sentinel edge case**: `roomId=0` is ambiguous while room 0 exists.
- **Chat receive limit**: only the input limit (55) is known.
- **Clan war** results persistence and a real client trigger; **clan chat** log (`chat_private_clan`).
- **Not verified live**: clans with the real client UI, Docker deploy, `AmmoRecharge`, `Suicide`, chat `Notice2`.
