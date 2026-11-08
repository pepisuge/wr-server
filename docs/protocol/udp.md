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

The first 29 bytes are plaintext; the body is XORed with `0xC3` (runs of `c3` are encrypted zeros). Decrypted body = `[len hi][0x60-byte struct]`; offsets below are inside the struct (add 1 for the body offset). Decoded with `WR_UDP_DUMP` recordings of controlled actions on client 22.

| struct offset | meaning |
|---|---|
| 0-1 | sender slot (u16 LE) |
| 2 / 3 / 4 / 5 | moving forward / back / right / left (bytes) |
| f@12 (copy f@40) | **yaw**, degrees |
| f@44 | **pitch**, degrees (f@8 = 360 - pitch) |
| 20 | crouched |
| 22 | state: 0 still, 1 walking, 2 jumping |
| 24 / 26 | firing state |
| f@28 / f@32 / f@36 | **X / height / Z** (copies at 72-80 and 84-92; eye = height + ~24.2) |
| f@56 | eye height / bob (18.2 standing, 15.6 crouched) |
| f@60 | **health** % |
| 65-68 | weapon / ammo (byte 68 = rounds) |

Walking forward moves along `(sin yaw, -cos yaw)` at ~75 units/s. Position matches the target position `PlayerDamage` carries in plaintext over TCP.

Only `0x31` has been observed from a real client during normal movement; `0x10`/`0x30`/`0x32`/`0x34` have never been captured.

## Tunnel header: what the receiving client validates

A scripted client used to be invisible on a real client (client 22) even with a perfect roster and UDP stream. The receiver drops a game frame unless:

- bytes 6-7 (u16 BE) = the local room id;
- bytes **8-9 = the sender's room slot** (index into the receiver's peer table);
- bytes 4-5 = the sender's session id, matching that peer;
- once the peer is "connected", bytes 10-13 (nonce) match the one it first used.

Copying another player's header (bytes 8-9 = their slot) is what made every frame get discarded. Bytes 26-27 = target slot.
