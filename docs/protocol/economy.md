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

Rates come from the `gameconfig` table (`expRate`, `dinarRate`, `levelup_base_reward`). The premium bonus multiplies only the `points x 4` term. Owned booster items add to that term (dinar: to `points x 3`), as long as the lease runs; no activation step:

| item | XP | dinar | source |
|---|---|---|---|
| `CD01` / `CD02` | +30% / +20% | | Chapter-1 `Player.cs` |
| `CE01` / `CE02` | | +20% / +30% | Chapter-1 `Player.cs` |
| `CC05` DoubleUp | +25% | +25% | Chapter-1 `Player.cs` |
| `CC03` UP_EXP | +30% | | our own (unwired in both references) |
| `CC04` UP_DINAR | | +30% | our own (unwired in both references) |
| `CC02` SUPERMASTER | +5% for everyone in a room its owner created | +10% for that room's master, if they own `CC02` | Chapter-1 `Player.cs`; the room's supermaster flag (room list) drops when the master changes |

The other extras need nothing from the server beyond the inventory list: client 22 (`FUN_004c2d60`) checks the owned codes `CF01` (stamina x1.2), `CF02`, `CJ01`/`CJ02` (extra magazines), `CG01`/`CG02` (scopes) and `CH01` (bandage) itself. `CF01` and `CJ01` verified live. `CF02`, `CG01`, `CG02` and the stamina `DS03` (slot 6, like the adrenaline) are sold from `sql/14` (the dump had them unbuyable); it also copies client 22's `items.bin` prices for `DS03`, `CF02`, `CH01` and `D101`, where the dump differed (DS03 for 3 days closed the connection, live). Owning `CI01`, the packages `CC05`/`CC09`-`CC15` and a few weapons (`DA10`, `DA20`, `DL02`, `DP01`, `DX02`, `DU03`) crashes client 22's shop while scrolling (no item data in the client): never give them. The HP kit `DS10` crashes it just by being listed (active in a modded `items.bin`): it has no icon/model among the client's textures, unlike the stamina `DS03`; keep it inactive client-side (it is not sold by the server either). `CI01` (RELOAD_UP) appears nowhere in the client: no effect, and `item_shop` already has it unbuyable.

Crossing a threshold sends `LevelUp` (`0x7920` = 31008) and pays the level-up reward. Room level limits (1-10, 11+, 21+, 31+, 41+) are enforced on create/join.

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

Validation order: code/format, for sale, inventory space (max 32), premium, level, price exists for that duration, enough money, not a retail item or one still being stored. Errors: `97020` not buyable, retail or a purchase already in progress, `97040` not enough money, `97060` premium/level requirement, `97070` inventory full.

**The client draws the shop from its own data files and sends the price index it chose**; the server checks it against `item_shop.cost`. An unknown code, a duration index out of range or a price mismatch **closes the connection** (treated as tampering). Keep the DB prices identical to what the client shows. Index 4 (permanent) is accepted.

**Renewal**: buying a still-valid item you own extends it from its current expiry: the existing `user_inventory` row's `length` grows (the reference inserted a second row and extended only memory, so the expiry could go back at the next login). If several rows for one code exist (re-bought after expiry, GM grants), the one with the furthest expiry wins at login.

### Using an item (`0x7800` = 30720)

```
client: id=30720 blocks=[1111, 4, 6, CB01, provaadmin]
server: id=30720 fields=[1111, 1, CB01, <itemlist>, <slotState>, provaadmin]
```

Client 22 uses items two ways. `CB01` (it asks for a name first) goes on `0x7800` (`FUN_00468810`), code at index 3 and the name at 4. `CB03` goes on `ITEMSHOP` instead: `[1111, CB03, 6, 7, -1]`, answered with the purchase shape and action `1111` (`[1, 1111, -1, 3, n, itemlist, money, slotState]`); the client then zeroes its own kill/death counters and shows "Item use successful." (`FUN_005f5f10`). An error there (`97010`) shows "item is no longer valid". Ported from ToXiiC `CashItemBuy.cs` (`OnItemUse`, `SP_CashItemUse`): `CB01` renames the account (`users.displayname`), `CB03` resets kills/deaths (reply adds `0, 0, money`); the item is consumed. A nickname is 3-16 letters/digits and may not start with `GM`, `System`, `Notice`, `ClanSystem` or `Admin` (the server signs its own lines with those; the website registration uses the same rule). Another player's nickname, in any case, is refused by the unique index on `displayname` (case-insensitive collation): the UPDATE itself is the check, so two players racing for one name cannot both get it. A refused rename keeps the item and replies `[1111, error, code, itemlist]`; client 22 (`FUN_005f8aa0`) shows a message box per error: `74070` (or `-1`) = "This WarRock nickname has already been taken" (used for taken and reserved names), `74100` = length/characters, `74110` = forbidden word, `74030` = empty (the last three have Korean text only). A too-short name never reaches the server: the client checks it itself and shows `m134_7`, in Korean because `textdata_eng.lua` lacks `m134_5`…`m134_11` (a client-mod fix, not a server one). Verified live: `Rivale` and `System1` show "already taken" and keep the item. A whisper is not seen there: the inventory window hides the chat and keeps waiting for the reply. `CB01`/`CB03` are bought for dinar like any item (`sql/13`). Verified live (rename, rename back, buy).

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
| `/closeroom`, `/endgame`, `/extendtime` | room control |
| `/start` | makes the GM master and lets the room's next Start skip the ready / team-balance checks; the GM then presses Start. The client only starts a match when it sends Start itself: a server-pushed `START_REPLY` is ignored (live, same as the autostart attempts) and leaves the room "Playing" with nobody in a match |
| `/takemaster`, `/setmaster <player>` | new: the GM (or a player) becomes room master. No captured packet says "new master": a `RoomLeave` broadcast for an **empty** slot carries the new master in its master field (the field clients read when a master leaves); verified live, the client follows it. Needs one empty slot |
| `/setlevel`, `/addmoney`, `/setpremium <player\|id> <tier 0-4> <days>` | progression (`days=0` = no practical expiry) |
| `/warn` | new: a whisper to the target |
| `/strikes <player>` | new: the player's last anticheat strikes this session (kind, detail, age); online GMs also get every strike as a whisper when it happens |

Removed: `/map` and `/maps` (changed the map only server-side; the room master's own map selector works), `/spawnfields` and `/spawncycle` (spawn-point investigation tools, finished: see [match](match.md)).

Every handler runs behind a guard in the dispatcher: a failing handler logs the error and affects only the offending connection, never the whole process. Money updates use `GREATEST(0, CAST(money AS SIGNED) + ?)` because the column is unsigned.
