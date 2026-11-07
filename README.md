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
Or `docker compose up -d` (copy `.env.example` to `.env` first; run `git submodule update --init` beforehand).
Protocol notes and design history: [`Protocollo WarRock.md`](Protocollo%20WarRock.md) (Italian).

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
