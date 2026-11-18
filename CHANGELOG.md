# Changelog

What changed between releases, for server operators. Each release is a git tag `vX.Y.Z`;
apply the new `sql/` patches it lists before starting the new code (`schema_version` tells you where your DB is).

## Unreleased

- Vehicles and artillery (Urban Ops / Battle Group): enter, change seat, leave, repair, damage to and from vehicles, destruction kills the crew, respawn after the vehicle's interval (#5). Data from the existing `vehicletypes`, `vehicleseats`, `vehicleweapons`, `map_vehicles` tables.

## v0.1.0 (2026-11-16)

First tagged release: everything up to here.

### Database
- Patches `sql/03` to `sql/14`; `sql/12` adds `wres2.schema_version`, and the game server warns at boot when the DB is behind.

### Game
- Rooms: create/join/leave, teams and slots, master handover, kick, votekick (#50), autostart (#49), settings.
- Modes: Explosive, TDM, FFA with round timer, scoreboard and match-end rewards.
- Chat: lobby, room, team (#51), clan, whispers; no impersonation, limits, `/notice` popup (#35); English system messages (#45).
- Items: shop and coupons stored atomically (#32), XP/dinar boosters (#52), renewal and supermaster CC02 (#53),
  rename CB01 and kill/death reset CB03 (#54, #55), stamina and scopes buyable (#57), mines that spare their owner (#56).
- Bleeding under 300 HP unless owning CH01 (#58).
- Clans: website management, clan wars with results and ranking, emblems (#36, #37); client mod installer (#38).
- GM commands, anticheat alerts, `/strikes`, `/tempban`, room control (#40).

### Security
- Game login only for sessions the auth server announced; internal channel key; UDP handler that never throws (#13).
- Failed-login throttle, single-use sessions (#18); scrypt passwords, connection and packet limits (#29).
- UDP sessions tied to their network endpoint (#28); damage validation (#27); server-side anticheat (#39).

### Operations
- `LOG_LEVEL` (#30), graceful shutdown (#31), `WR_PATCH_VERSIONS` (#47), tests for rooms and shop in CI (#48).
- Supervisor `node tools/supervise.js` restarts a server that exits or stops answering; Docker `restart: unless-stopped` (#67).
- Code comments trimmed to the why; findings moved to `docs/protocol/` (#70-#74).
