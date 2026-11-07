---
layout: page
title: UDP relay
permalink: /protocol/udp
---

See [fundamentals](fundamentals#udp-a-different-protocol) for the header layout and the endpoint encoding.

## The server is a mailman, not a physics engine

All real-time traffic travels as `type=0x1010` with a subcommand byte at offset 14. The server:

1. reads only the sender (`sessionId` @4), the room (@6) and the target (`targetId` @22);
2. checks that sender and target are in the same room **and** that the room is `Playing`;
3. forwards the packet **byte for byte** to the target's public UDP endpoint learned during the handshake.

Movement is **client-authoritative**. Relay is point-to-point: N players means N sends per tick.

## Handshake: `Initial` (0x1001) -> `Ping` (0x1010)

1. The client sends `Initial` to UDP 5350. The server answers with the same packet, bytes 4-5 rewritten to "port + 1" (5351).
2. The client sends `Ping` (subcommand `0x21`), exchanging local and public endpoints. This is how a client behind NAT learns its public IP, and the **only** time the server learns the player's public endpoint.
3. Reply: a 65-byte copy of the incoming packet with `response[17] = 0x41`, `response[64] = 0x11`, sessionId at offset 4, the endpoint seen by the server at offset 32 and the client-declared local endpoint at offset 50 (both encoded).

## NAT keepalive

Idle NAT mappings expire (e.g. Windows ICS) and the client drops back to the server list. Every 60 s the server re-sends to each player the **same handshake reply** stored at handshake time. Any datagram refreshes the mapping.

## Movement packet body (subcommand `0x31`)

The first 29 bytes are plaintext; the body is XORed with `0xC3` (runs of `c3` are encrypted zeros). Decoded float fields:

| body offset | meaning |
|---|---|
| 9 | aim yaw (0-360 degrees) |
| 13 and 41 | the same value twice, looks like a heading |
| 17 | always 1.0 |
| **29** | **X coordinate** (confirmed) |
| 33 | unknown, **not** Y |
| **37** | **Z coordinate** (confirmed) |
| **61** | **health** (confirmed) |

Confirmed by comparing with the target position that `PlayerDamage` carries in plaintext over TCP.

Only `0x31` has been observed from a real client during normal movement; `0x10`/`0x30`/`0x32`/`0x34` have never been captured.

## Open problem: the invisible fake player

A scripted client can do everything right protocol-wise (roster, scoreboard, spawn broadcast, continuous UDP stream replaying real captures) and still **never be drawn** as a character on a real client. Spawn timing, the UDP stream, GameSub 402 and the spawn payload shape have been excluded by live tests. What makes the client draw a remote character lives in the executable. Don't retry without a new capture or clue.
