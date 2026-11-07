---
layout: page
title: Protocol reference
permalink: /protocol/
---

How the WarRock client and this server talk. Organized by topic: each page gives the current, verified state of knowledge.

Two rules hold everywhere:

1. **A capture against the real client beats the C# reference code.** When they disagree, what is on the wire wins.
2. **Check both C# references before calling an area "missing".** [WarRock-Chapter-1-Server](https://github.com/sweetriverfish/WarRock-Chapter-1-Server) and ToXiiC Core differ a lot: GM commands and clans are skeletons in the first and fully wired in the second.

## Pages

1. [Fundamentals](fundamentals): architecture, ports, TCP framing and XOR, field escaping, dispatch, UDP basics, decoding method
2. [Connection flow](connection): from launcher to lobby (login, server list, game authorization, ping)
3. [Lobby and rooms](rooms): channels, user list, chat, room create/join/leave/kick/invite
4. [Match flow and combat](match): start, tick, spawn, end of round, modes, damage, hitboxes, death
5. [UDP relay](udp): handshake, NAT keepalive, tunnel, movement packet body
6. [Progression and economy](economy): levels, premium, shop, equipment, coupons, GM commands
7. [Clans](clans): the `CLAN_SYSTEM` packet and its subtypes
8. [Opcode tables and constants](reference): every opcode, subtype, error code and constant; open problems

Contributors: if your change alters protocol behaviour, update the matching page in the same PR.
