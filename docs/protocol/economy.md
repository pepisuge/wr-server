---
layout: page
title: Progression and economy
permalink: /protocol/economy
---

## Levels and XP

The level is never stored, only raw XP (`user_details.xp`). It is derived from a 100-entry threshold table (`LevelCalculator.cs`): `xp=2200` is level 1, `xp=2300` is level 2 (first threshold 2250).

XP is earned at end of match and when leaving a `Playing` room:

```
xp = ceil((20 + points x 4 x premiumRate) x expRate)        points = kills
```

Rates come from the `gameconfig` table (`expRate`, `dinarRate`, `levelup_base_reward`). The premium bonus multiplies only the `points x 4` term. Crossing a threshold sends `LevelUp` (`0x7920` = 31008) and pays the level-up reward. Room level limits (1-10, 11+, 21+, 31+, 41+) are enforced on create/join.

**Persistence pattern used everywhere**: update **memory first** (source of truth for immediate replies), then write to the DB fire-and-forget. Handlers that `await` the DB before touching shared state race with the next packet from the same client.

## Premium

```
0 = Free2Play   1 = Bronze   2 = Silver   3 = Gold   4 = Platinum
```

The reference XP bonus array has 4 cells (`{0, 0.2, 0.3, 0.5}`); Platinum falls back to no bonus instead of crashing. Visible effects: 5th inventory slot (`SlotState` `T,F,F,F`) and the remaining-time countdown in `Ping`. Expiry is checked live in the ping loop: the player drops to Free2Play with a chat notice and is **not** disconnected.

## Inventory and shop

Tables share a 4-letter item code (`DA02`, `DC01`, `CA04`...):

- `item_weapons` / `item_extra`: catalog.
- `item_shop`: whether and how much; `cost` is a list of 5 prices by duration (3/7/15/30 days, permanent).
- `item_equipment`: allowed slots per class (8 flags x 5 classes).
- `item_target_info`: combat stats.
- `user_inventory`: purchases. No slot is persisted.
- `user_equipment`: one row per user, 5 CSV columns (one per class), sent to the client as is.

Ten base weapons can always be equipped for free: `DA02, DB01, DF01, DG05, DC02, DJ01, DR01, DQ01, DN01, DL01`.

### Purchase (`Itemshop`, `0x7600` = 30208)

```
client: id=30208 fields=[1110, DC01, 0, 0, 1]
server: id=30208 blocks=[1, 1110, -1, 3, 1, DC01-1-0-26082810-0, 145100, F,F,F,F]
```

Validation order: code/format, for sale, inventory space (max 32), premium, level, price exists for that duration, enough money, not already owned. Errors: `97020` not buyable or already owned, `97040` not enough money, `97060` premium/level requirement, `97070` inventory full.

**The client draws the shop from its own data files and sends the price index it chose**; the server checks it against `item_shop.cost`. An unknown code, a duration index out of range or a price mismatch **closes the connection** (treated as tampering). Keep the DB prices identical to what the client shows. Index 4 (permanent) is accepted.

Owning a still-valid item blocks a new purchase (the reference inserts a duplicate row instead; renewal is not implemented).

### Equipment (`0x7512` = 29970)

The code must exist and be an active weapon, fit that slot for that class (`item_equipment`), and be owned (or a base weapon). The result is saved to `user_equipment`. Violations close the connection. GMs may bypass only the slot/class check, not ownership. `97090` = already equipped.

### Coupons (`0x8100` = 33024)

A text code redeemed for money and/or items. Item rewards are answered with the shop success packet.

```
client: id=33024 fields=[MEOW]
server: id=33024 blocks=[0, 0, 119000]
```

Uses counter: `0` exhausted, `-1` unlimited, positive decrements. `user_coupons` (unique per owner and coupon) prevents redeeming the same coupon twice, a hole in the reference.

## GM commands

GM rights come from `user_details.is_gm`, set directly in the DB; nothing the client sends affects it (its `AccessLevel` field is ignored).

A command is a normal `CHAT` packet starting with `/`, intercepted before broadcast for GMs only. Replies are whispers from `GM` with `GM>> ` on every line. Targets: by display name if online, else by account id. `/help` is taken by the client, hence `/gmhelp`.

Ported from ToXiiC Core:

| command | notes |
|---|---|
| `/notice <msg>` | notice popup (type 2) in the lobby, yellow `Notice>> ` line for players in a room |
| `/kick`, `/kickroom` | `/kickroom` sends only `ROOM_KICK` (see [kick](rooms#kick-29505)) |
| `/mute`, `/unmute` | `user_details.mutedexpire` |
| `/ban`, `/unban` | `users.status` in the login DB (`73050` on next login) |
| `/tempban <player\|id> <hours> [reason]` | new: `status = 0` plus `users.ban_until` (`sql/11`); the game and website logins lift it once that time has passed |
| `/giveitem`, `/giveroom` | same insert as a real purchase |
| `/userinfo`, `/roominfo`, `/online` | in-memory state (`/roominfo` shows the map name) |
| `/closeroom`, `/start [force]`, `/endgame`, `/extendtime` | room control (`force`: start even if not everyone is ready or teams are uneven) |
| `/takemaster`, `/setmaster <player>` | new: the GM (or a player) becomes room master. No captured packet says "new master": a `RoomLeave` broadcast for an **empty** slot carries the new master in its master field (the field clients read when a master leaves). Needs one empty slot |
| `/setlevel`, `/addmoney`, `/setpremium <player\|id> <tier 0-4> <days>` | progression (`days=0` = no practical expiry) |
| `/warn` | new: a whisper to the target |
| `/strikes <player>` | new: the player's last anticheat strikes this session (kind, detail, age); online GMs also get every strike as a whisper when it happens |

Removed: `/map` and `/maps` (changed the map only server-side; the room master's own map selector works), `/spawnfields` and `/spawncycle` (spawn-point investigation tools, finished: see [match](match.md)).

Every handler runs behind a guard in the dispatcher: a failing handler logs the error and affects only the offending connection, never the whole process. Money updates use `GREATEST(0, CAST(money AS SIGNED) + ?)` because the column is unsigned.
