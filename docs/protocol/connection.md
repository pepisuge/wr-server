---
layout: page
title: Connection flow
permalink: /protocol/connection
---

```
Client -> Auth :5330   connect
Auth   -> Client       Connection (4608) [nonce, 77]
Client -> Auth         Launcher/patch check (4112)
Auth   -> Client       Launcher (4112) [0,0,0,0,0,0, http://]
Client -> Auth         Login (4352) [checksum, 0, user, password, 0, 0]
Auth   -> Client       ServerList (4352) [account + server list]
Client -> Game :5340   connect (new TCP connection)
Game   -> Client       Connection (4608) [nonce, 77]
Client -> Game         ServerTime (24832) [checksum, 3, MAC]
Game   -> Client       ServerTime (24832) [1, "ss/mm/HH/dd/month/year/week/yearDay/0"]
Client -> Game         Authorization (25088) [userId, -1, user, nick, sessionId, ...]
Game   -> Client       Authorization (25088) [1, account/inventory/equipment...]
Client -> Game         ChannelSelection (28673) [channel]
Game   -> Client       ChannelSelection (28673) + RoomList (29184) + UserList (28928)
```

## Connection (4608)

First packet the server sends on every new connection (login, game and internal channel). Two fields: a random 9-digit nonce and the constant `77`. Nothing downstream appears to depend on them.

## Patch check (4112)

```
IN  id=4112 (no fields)
OUT id=4112 fields=[0, 0, 0, 0, 0, 0, http://]
```

Answering `0` in every version field makes the client conclude it is up to date.

## Login (4352)

```
IN  id=4352 blocks=[1335749171, 0, <user>, <password>, 0, 0]
OUT id=4352 blocks=[1, 100, 0, <user>, NULL, <nick>, 24693, 1, 0, 1, 1, 1, Spain, 127.0.0.1, 5340, 0, 0, -1,-1,-1,-1, 0, 0]
```

`blocks[2]`/`blocks[3]` are username and password. Passwords are stored as `SHA256(password + salt)` with a per-row salt.

Errors: `72010` unknown user, `72020` wrong password, `73050` banned (`users.status <= 0`), `74010`/`74020` empty fields.

After 5 failed logins (unknown user or wrong password) from one IP within 5 minutes, that IP gets `72020` for every login until the window ends, right password included.

- **An extra field shifts everything.** The C# sends a version field (`1.11025`) before the server count. Client 22 needs it (the server sends it); an older 17.x build showed the server as "full" with a garbage name when it was present. Every field is read blindly by position.
- **The server IP in the list** is the local address of the incoming TCP connection (`socket.localAddress` without `::ffff:`), not a configured IP: a hardcoded `127.0.0.1` breaks every non-local client. Auth and Game run on the same host and listen on all interfaces.

## Internal channel: Game registers with Auth (5012)

```
Game -> Auth   connect :5012
Auth -> Game   Connection (4608) [nonce, 77]
Game -> Auth   Authorization (4096) [1, key, "Spain ", ip, port, type]
Auth -> Game   Authorize (4096) [1, serverId]
Auth -> Game   PlayerAuthorization (4864) [sessionId, userId, username, displayname]   on every login
```

- Auth **checks the key** against `game.serverKey` (env `GAME_SERVER_KEY`) and refuses other registrations: a registered server receives every login's session. The reference reads the key but never checks it. Change the default key and never expose 5012.
- `PlayerAuthorization` is pushed to every registered Game server *before* the server list reaches the client. Game only accepts an `Authorization` (25088) whose `sessionId`, `userId` and `username` match one of these; each session is **single-use** and expires after 10 min (client 22 goes back through Auth, with a new session, on every reconnect). The reference does the same check as a Game->Auth request on the same id; a push is simpler here because both run side by side.
- Game reconnects every 3 s if Auth goes away, so start order does not matter.

## Game server authorization

**`ServerTime` (24832)** doubles as an anti-cheat check: the client sends `versionId=3` and its **MAC address** (12 hex chars), checked against `macaddress_blacklist`. The reply is the time as slash-separated fields (`sec/min/hour/day/month(0-based)/year-1900/week/yearDay/0`).

**`Authorization` (25088)**: the client sends back the `sessionId` from login (`[userId, ?, username, displayname, sessionId, ?, ?, accessLevel]`). It is only accepted for a session Auth announced (see the internal channel above); the displayname comes from Auth, not from the packet. The reply is large: account, clan, level, inventory, equipment, slots (`F,F,F,F` = 4 inventory slots disabled, `^` = no item) and the **five class loadouts**, sent once per session only.

Level, money and the 5th inventory slot are only read from this packet, so changes during a session are invisible until re-login (`/setlevel` and `/addmoney` disconnect the target; `/setpremium` does not).

- **`AccessLevel` (`blocks[7]`) is written by the client** and must never be trusted. GM rights come from `user_details.is_gm` (see [economy](economy#gm-commands)).
- **Duplicate logins**: if the same `userId` or `sessionId` is already online, the new connection gets `92040` (`IdInUse`) and is closed.

## Ping and liveness (25600)

The server sends `Ping` (`0x6400`) every 5 s to everyone; it carries the **remaining premium time**, and is where premium expiry is checked. The client answers each Ping with an identical packet; a user silent for 20 s (4 missed pings) is disconnected through the normal cleanup path. This catches connections that die without a close event (unplugged cable, NAT drop).
