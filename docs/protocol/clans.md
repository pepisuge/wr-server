---
layout: page
title: Clans
permalink: /protocol/clans
---

`CLAN_SYSTEM` = `0x6710` = **26384**, envelope `[subtype, ...payload]`. Ported from ToXiiC Core (`Game/Clan.cs`, `CP_Clan`); Chapter-1-Server only has read-only clan code.

| subtype | name | notes |
|---|---|---|
| 0 | `CHECK_NAME` | is the name free? (`62003` = exists) |
| 1 | `CREATE` | **name only**, costs 10000 dinars |
| 2 | `APPLY` | application (pending), not an instant join |
| 3 | `LEAVE` | the master leaving disbands the clan silently (as in the reference) |
| 4 | `MY_CLAN` | own clan panel, read-only |
| 5 | `MEMBERS` | roster + applicants |
| 6 | `SEARCH` | search by name |
| 7 | `INFO` | |
| 8 | `ChangeAnnDec` | not handled (needs item `CB02`/`CB54`) |
| 9 | `JOIN_ACTION` | accept/reject an applicant (+ membership check) |
| 10 | `RANK_ACTION` | rank change, kick (+ membership check) |
| 11 | `PROMOTE` | hand over master (+ master-only check, missing in the reference) |
| 12 | `NickChange` | not handled |
| 14 | `MarkChange` | not handled |
| 16 | `DISBAND` | |
| 17 | `NewSearchClan` | not handled |
| 1000 | `START_WAR` | **self-designed**, deliberately outside the real 0-17 range |

Ranks (`clanrank`): `0` member, `1` officer, `2` master, `9` pending applicant.

`CLAN_RANKING` = `0x6760` = 26464 is a separate opcode. Clan chat is chat type `10`; forwarding to online members is our own logic (the reference only logs it).

## Deviations from the reference

- Clan ids use the table's `AUTO_INCREMENT`.
- `exp` is derived (`wins x 250`); `iconid` (`1001001`) and `maxusers` (20) are fixed, as ToXiiC's defaults at creation; member join date is approximated with the clan creation date.
- Display names come from the login DB with one batched `WHERE id IN (?)` query.
- Online membership is always derived live from connected users with the same `clanId`.
- `JOIN_ACTION`, `RANK_ACTION` and `PROMOTE` check the target's real clan and rank, online or offline (read from `user_details`): only a pending applicant of this clan can be accepted/refused, the master can't be demoted or kicked, master goes only to a member/officer. Refused actions get a system whisper.

## Website

`node/game/web.js` (inside the game server, port `WR_WEB_PORT`, default 8080) runs the same actions (`createClan`, `applyClan`, `leaveClan`, `disbandBy`, `joinAction`, `rankAction`, `promote` in `clan.js`) from plain HTML forms, so the in-memory state stays shared with the game. Leaving as master is refused there (in game it silently disbands): the site has an explicit disband button. Plain HTML with no client JS, so the page also works in the game's embedded browser: the client chat command `/url http://<server>:8080/clan` opens it, `/close url` closes it (client-side, never sent to the server).

Clan emblems: the client downloads `http://ops.warrock.net/ClanAvatar.aspx?Clan=<name>` with `URLDownloadToFile` (code at `0x4cd620` in client 22) and loads the file through Direct3D; on failure it falls back to `texture/Avata/DefaultClanMark.jpg`, which the client doesn't ship (white box). The site serves `/ClanAvatar.aspx?Clan=<name>`: a generated 32x32 BMP shield coloured from the name. Point the client at it with a hosts entry for `ops.warrock.net` (port 80) or by patching that push (the clan UI DLL does).

## Clan war (self-designed)

`isClanWar`/`Clan1`/`Clan2` exist in the room packets (`-1` = no), but neither reference shows how a real client starts a war. Here a master declares war on another clan by id (`START_WAR = 1000`): the server creates a room with `isClanWar=1` and assigns teams by clan (challenger team 0, challenged team 1); the other clan gets a chat notice. Manual team changes are ignored. War results (`wins`/`losses`/`draws`, `exp`) are not persisted yet.

## Status

The full cycle (create, apply, accept, rank, promote, disband, search, ranking) is verified with a scripted client; the real client UI is not verified yet (icon/description fields may need a different format). Clan emblems are tracked as a separate feature.
