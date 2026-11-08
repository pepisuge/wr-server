# wr-server

Open-source private server for **WarRock** (2008 FPS), written in plain Node.js (CommonJS, no build step).
Two processes: `auth-server.js` (login / server list) and `game-server.js` (rooms, shop, clans, matches).

> **Not affiliated with, endorsed by or connected to the owners of WarRock or its publishers.**
> All trademarks belong to their respective owners. This repository contains **no game client, assets or
> game data files** and never will; you need your own legitimate copy of the client. Educational / preservation project.

## Quick start
```bash
cd node && npm install
# MariaDB with two databases: masterserver (login) and wres2 (game); schemas come from the upstream reference + ./sql
node auth-server.js
node game-server.js
```
Without Docker: load `WarRock-Chapter-1-Server/Databases/*.SQL` (`git submodule update --init`), then `sql/03`…`08` into `wres2`, in order.
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
| `WR_PONG_TIMEOUT_MS` | liveness timeout (raise it while a debugger pauses the client) |
| `WR_UDP_DUMP` / `WR_RECORD` | append raw UDP tunnel packets / decoded movement+hit events to a JSONL file |

Ports: 5330 (login) and 5340 (game) TCP, 5350-5351 UDP. **Never expose 5012** (internal channel).

### Checks
`cd node && node tools/test-hardening.js` (no DB). With the servers running: `node tools/smoke-login.js <user> <password>`
and `node tools/test-gamesubs.js`. CI runs all of them (the last two against the Docker stack).

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
