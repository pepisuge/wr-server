---
layout: page
title: Fundamentals
permalink: /protocol/fundamentals
---

## Architecture: two processes

`Authorization` authenticates accounts and keeps the list of available `Game` servers. `Game` is where people play. In 2008 a publisher ran one Authorization server and many Game servers (one per region); the client logs in once, then picks a world. After choosing a server the client opens a **new TCP connection** to the Game server and authenticates again there with a temporary `SessionID` issued at login.

| port | protocol | listener | purpose |
|---|---|---|---|
| 5330 | TCP | Authorization | login, patch check, server list |
| 5012 | TCP | Authorization | internal Auth to Game channel (never exposed to the client) |
| 5340 | TCP | Game | the whole game world (lobby, rooms, chat, combat) |
| 5350 | UDP | Game | initial UDP handshake |
| 5351 | UDP | Game | NAT ping and relay tunnel (movement, shots) |

Databases: `masterserver` (accounts, password hashes, `status` used for bans) is read by Auth; `wres2` (player details, inventory, items, coupons, clans, maps) is read by Game. Game keeps a small second pool to `masterserver` for `/ban` and for resolving display names in clan rosters.

This split scales without shared state: several `game` processes in front of one `auth`, and the client already picks a shard from the server list.

## TCP: text, XOR, newline

Before encryption every TCP packet is a **space-separated text line**:

```
<tick> <opcodeDecimal> <field1> <field2> ... \n
```

- `tick`: sender timestamp, never validated (the server uses `Date.now() & 0x7fffffff`).
- `opcodeDecimal`: packet type, always **decimal** on the wire (`24832` = `0x6100`).
- fields are read **by position**; nothing in the packet describes them.

**"Encryption"**: every byte is XORed with one fixed key per direction. XOR is its own inverse, so one function encrypts and decrypts.

**Framing**: the separator is `0x0A`. Decrypt first, then look for `0x0A` in the plaintext.

| channel | server to client | client to server |
|---|---|---|
| external (login 5330, game 5340) | `0x96` | `0xC3` |
| internal Auth to Game (5012) | `0x23` (Auth side) | `0xA3` (Game side) |

## Space escaping: `0x1D`

Space separates fields, so a real space inside a field is replaced with `0x1D` (ASCII Group Separator) before sending:

```js
const str = [tick, id, ...fields.map(f => String(f).replace(/ /g, '\x1D'))].join(' ') + ' \n';
```

In raw logs multi-word fields look glued together (`comehere` instead of `come here`). That is `0x1D`, not a bug; restore with `.split('\x1D').join(' ')`. Chat text arrives as `"Nick>>\x1Dhello\x1Dworld"`.

## Opcode notation and the signed 16-bit trap

The same opcode appears as hex in the C# enums (`0x7531`), sometimes as a decimal literal in C# code (`26384`), and always as decimal on the wire.

Many integers are implicitly **signed 16-bit**. The `SessionID` is stored by the client as a `short`: any value above `32767` comes back negative (`39574` returns as `-25962`) and fails validation with error `73030`. Session ids are therefore allocated sequentially in `1..32766`.

## Dispatch: two levels

1. **Top-level opcodes**, one per packet type (`CHAT` 29696, `ROOM_JOIN` 29456, `SCOREBOARD` 30032...), dispatched by an `id -> handler` map.
2. **Subtypes inside `GAME_PACKET` (`0x7530` = 30000)**: every in-room action (ready, team change, spawn, damage, death...) travels inside this opcode with a fixed 4-field header:

```
[sender slot, room id, unidentified field, subtype, ...payload]
```

Example (team change): `[1, 1, 2, 56, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0]` = slot 1, room 1, subtype 56 (`SIDE_UPDATE`).

Several packets that look like in-game actions are **top-level, not subtypes**: `GameTick` (30016), `EndGame` (30048), `Scoreboard` (30032), `Equipment` (29970), `Explosives` (29984), `GameCountDown` (30001).

The game packet dispatcher sends **one response per incoming packet**; any extra work (e.g. autostart after `READY`) is flagged in the return value and sent after the normal reply. The dispatcher also silently drops a `GAME_PACKET` whose header slot does not match the player's real slot.

**Unknown packets are silently ignored**, by the server and by the client. "The client did not react" does not prove a packet was malformed: the client may simply not handle that opcode.

## UDP: a different protocol

UDP is **binary, fixed offsets, big-endian**. Node's `readUInt16BE`/`writeUInt16BE` work natively; do not copy the C# byte-swapping.

| offset | size | field |
|---|---|---|
| 0 | u16 BE | type (`0x1001` Initial, `0x1010` Ping/tunnel) |
| 4 | u16 BE | sender sessionId |
| 6 | u16 BE | room id |
| 14 | 1 byte | subcommand (`0x21` handshake; `0x10`/`0x30`/`0x31`/`0x32`/`0x34` tunnel) |
| 22 | u16 BE | targetId (who to relay to) |
| 32 | 6 bytes | endpoint IP:port (encoded) |
| 50 | 6 bytes | second endpoint (encoded) |

NAT endpoint encoding (6 bytes = port + IPv4, XOR plus a byte reversal):

```js
const READ_KEY = 0xc3, WRITE_KEY = 0x96;
function readEndpoint(buf, offset) {
  const b = Buffer.from(buf.subarray(offset, offset + 6)).map(x => x ^ READ_KEY);
  return { ip: `${b[2]}.${b[3]}.${b[4]}.${b[5]}`, port: b.readUInt16LE(0) };
}
function writeEndpoint(buf, offset, ip, port) {
  const value = Buffer.from([port & 0xff, (port >> 8) & 0xff, ...ip.split('.').map(Number)]).reverse();
  for (let i = 0; i < 6; i++) buf[offset + i] = value[i] ^ WRITE_KEY;
}
```

## Capturing traffic

No Wireshark needed: the server sits in the middle of every exchange, so its log is the capture tool. TCP packets are logged as `IN tick=... id=... blocks=[...]` / `OUT id=... fields=[...]`; the UDP path samples the first packet of each `(subcommand, length)` shape and then one in 20, with a hex dump.

## Decoding an unknown packet: what worked

- **Distinct marker per field.** Send a recognizable value that differs per position (e.g. `1000 + index`) and see which comes back. Keep the fields that must look valid (sessionId, name, xp) real, or the client drops the whole packet. If a marker never comes back from any position, the client does not read that field at all.
- **Fields at a different offset than the C# says** are the most common failure here: room invite password, `MODE_UPDATE` (`payload[0]`, not `payload[2]`), `PlayerDamage` headshot flag (index 17, not 18), `EndGame` round counters (positions 1-2).
- **Reuse a packet the client already renders.** Before inventing a format, find which working packet produces the same effect when the user does it by hand (refresh button, Tab key, page buttons).
- **Order matters.** The client drops an update that arrives before the confirmation that makes it relevant; check arrival order, not just content.
- **If flipping a value gives the same broken result, it is the wrong field**, not the wrong sign.
- **Echo is the default.** Many client actions wait for an echo of their own packet (`BackToLobby`, `ConfirmDeath`); "no handler in the C#" does not mean "no reply needed".
- **Stop when attempts become blind.** After 3-4 independent attempts with the same negative outcome and a provably correct server state, the answer is inside the client executable, not in the next packet variant.
