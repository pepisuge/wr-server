# wr-server

Open-source private server for **WarRock** (2008 FPS), written in plain Node.js (CommonJS, no build step).
Two processes: `auth-server.js` (login / server list) and `game-server.js` (rooms, shop, clans, matches).

> **Not affiliated with, endorsed by or connected to the owners of WarRock or its publishers.**
> All trademarks belong to their respective owners. This repository contains **no game client, assets or
> game data files** and never will; you need your own legitimate copy of the client. Educational / preservation project.

## Project status

> [!IMPORTANT]
> Estimated completion per area, measured against the real client (**Client 22**). Last update: **2026-11-10**.
> "Done" means tested live with the real client, not only ported. Gaps link to their issue.

| Area | Progress | Works | Missing |
|---|---|---|---|
| **Login server** | `█████████▌` 95% | login, server list, launcher patch check, session handoff to Game, brute-force throttle, scrypt passwords, temporary bans, website sign-on token | configurable patch versions ([#25](https://github.com/pepisuge/wr-server/issues/25)) |
| **Game server core** | `█████████░` 90% | authorization, channels, ping/liveness, UDP relay with endpoint checks, graceful shutdown | supervisor ([#22](https://github.com/pepisuge/wr-server/issues/22)) |
| **Lobby system** | `████████▌░` 85% | channel select, room list and paging, user list, invites, quick join | |
| **Room system** | `████████▌░` 85% | create/join/leave, teams and slots, master handover (also by GM), kick, settings (map, mode, rounds, ping), GM spectator, GM-unlocked start, own clan emblem | votekick ([#6](https://github.com/pepisuge/wr-server/issues/6)), autostart transition ([#10](https://github.com/pepisuge/wr-server/issues/10)) |
| **CQC** (infantry) | `████████░░` 80% | Explosive, Free-for-All, Team Deathmatch, per-weapon damage, heal, mines, medic/ammo boxes, artillery, scoreboard, XP/dinar | damage falloff ([#9](https://github.com/pepisuge/wr-server/issues/9)) |
| **Urban Ops** | `█████░░░░░` 50% | everything in CQC on Urban maps | vehicles ([#5](https://github.com/pepisuge/wr-server/issues/5)), Conquest ([#4](https://github.com/pepisuge/wr-server/issues/4)) |
| **Battle Group** | `███▌░░░░░░` 35% | infantry modes on Battle Group maps | vehicles ([#5](https://github.com/pepisuge/wr-server/issues/5)), Conquest ([#4](https://github.com/pepisuge/wr-server/issues/4)) |
| **Chat system** | `████████░░` 80% | lobby, room, whisper, clan chat, mute, notice popup, impersonation/length/rate limits | team chat, English system messages ([#14](https://github.com/pepisuge/wr-server/issues/14)) |
| **Clan system** | `████████▌░` 85% | create, join/leave, ranks (master-only), members, clan chat, emblems in lobby and rooms (gallery or upload), clan wars declared from the site with results, points and ranking; in game through the CLAN button (client mod) | clan war accept/decline ([#42](https://github.com/pepisuge/wr-server/issues/42)), native client dialogs ([#12](https://github.com/pepisuge/wr-server/issues/12)) |
| **Shop & inventory** | `███████▌░░` 75% | buy (atomic), equipment and loadouts, coupons, rename and K/D reset items | renewal ([#8](https://github.com/pepisuge/wr-server/issues/8)), item effects ([#7](https://github.com/pepisuge/wr-server/issues/7)) |
| **Progression** | `████████░░` 80% | XP, levels, level-up rewards, premium, boosters | |
| **Anti-cheat (server side)** | `████████▌░` 85% | loadout, hit rate, knife range, attacker slot, connection/packet limits; speedhack (client clock and speed), teleport, superjump, no fall damage, OPK, hits ignored after a teleport until respawn; strikes, auto-kick, GM alerts | ammo, per-weapon fire rate, aim statistics, vehicles ([#41](https://github.com/pepisuge/wr-server/issues/41)); wallhack needs map geometry |
| **GM tools** | `████████▌░` 85% | moderation (kick, mute, ban, temporary ban, warn), economy and items, room control (take/set master, unlock start, close, end, extend), info, anticheat strikes | English messages ([#14](https://github.com/pepisuge/wr-server/issues/14)) |
| **Website** | `███████░░░` 70% | registration, login, sign-on from the game, clan management, emblem gallery and upload, clan war declaration, clan ranking | referral ([#34](https://github.com/pepisuge/wr-server/issues/34)), HTTPS setup, final design |
| **Client mod** (client 22) | `████████░░` 80% | CLAN button with the site in a game-style window, sign-on, clan emblems from the server (live refresh), installer/uninstaller with checked patches | test on another PC and first release ([#43](https://github.com/pepisuge/wr-server/issues/43)) |

**Overall: ~78%.** Open work is tracked in the [issues](https://github.com/pepisuge/wr-server/issues); protocol findings go to [`docs/protocol`](docs/protocol/index.md).

## Quick start
```bash
cd node && npm install
# MariaDB with two databases: masterserver (login) and wres2 (game); schemas come from the upstream reference + ./sql
node auth-server.js
node game-server.js
```
Without Docker: load `WarRock-Chapter-1-Server/Databases/*.SQL` (`git submodule update --init`), then `sql/03`…`11` into `wres2`, in order.
**Warning:** the upstream dumps contain `USE` + `DROP TABLE`, so they wipe an existing `masterserver`/`wres2`; back up first.

With Docker (from the repo root, after `git submodule update --init` and `cp docker/.env.example docker/.env`):
`docker compose -f docker/docker-compose.yml up -d --build`. Set `SERVER_IP` in `docker/.env` for LAN clients.
Protocol reference: [`docs/protocol`](docs/protocol/index.md), also published at <https://pepisuge.github.io/wr-server/>.

### Configuration
`node/config.json`, overridden by environment variables:

| variable | what |
|---|---|
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` | MariaDB for both servers |
| `GAME_AUTH_HOST` | where Game finds Auth's internal channel (5012) |
| `GAME_SERVER_IP` | IP announced when Game registers (the server list itself uses the address the client reached Auth on) |
| `GAME_SERVER_KEY` | shared Auth/Game key for the internal channel: **change it** on any reachable host |
| `WR_PATCH_URL` | patch base URL sent to the launcher (default `http://<auth address>/wr/`) |
| `WR_SERVER_TYPE` | server type sent in the list (client 22 test: 65..70) |
| `WR_MAX_CONN_PER_IP` | open connections allowed per client IP (default 10); raise it behind Docker Desktop or a proxy, where every client shares one IP |
| `WR_WEB_PORT` | website port inside the game server (default 8080, `0` = off); put an HTTPS reverse proxy in front of it on the internet |
| `WR_PONG_TIMEOUT_MS` | liveness timeout (raise it while a debugger pauses the client) |
| `LOG_LEVEL` | `debug` logs every packet (chat included) and UDP relay detail; default: connections, errors and warnings only |
| `WR_UDP_DUMP` / `WR_RECORD` | append raw UDP tunnel packets / decoded movement+hit events to a JSONL file |

Ports: 5330 (login) and 5340 (game) TCP, 5350-5351 UDP, 8080 website (HTTP). **Never expose 5012** (internal channel).

### Checks
`cd node && node tools/test-hardening.js` (no DB). With the servers running: `node tools/smoke-login.js <user> <password>`
and `node tools/test-gamesubs.js`. CI runs all of them (the last two against the Docker stack).

## Client mod

Players use the client 22 they already have plus [`tools/client22-mod`](tools/client22-mod/README.md): an installer that turns TRAINING into a CLAN button (the clan website in a game window, signed in from the game login), loads clan emblems from this server and points the client at it. Only our code and a checked recipe of changes are distributed, never game files.

## Contributing
Humans and AI agents are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Use the issue templates for bugs and ideas.

## Credits
The protocol and gameplay logic were ported from community emulators, used as a *specification*:
[sweetriverfish/WarRock-Chapter-1-Server](https://github.com/sweetriverfish/WarRock-Chapter-1-Server) (git submodule, not modified)
and ToXiiC Core by ToXiiC (<https://toxiicdev.net>, not included here). Thanks to their authors.

## Supporting the project
Donations are voluntary gifts toward hosting and development costs; nothing is sold. As a thank-you, supporters may receive
in-game **Premium** (XP / dinar bonus only: no weapons, no combat advantage). See [SUPPORT.md](SUPPORT.md).

## License
[MIT](LICENSE). Third-party code keeps its own licenses.
