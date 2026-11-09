---
layout: page
title: Lobby and rooms
permalink: /protocol/rooms
---

## Channel selection (28673)

```
IN  id=28673 blocks=[1]
OUT id=28673 fields=[1, 1]
OUT id=29184 (RoomList) fields=[0, 0, 0]     <- 0 rooms, page 0
```

The channel sets the maximum room size. Entering a channel notifies nobody else (same as the original).

## User list (28928)

`UserList` (`0x7100`) is requested by the client. The opcode `USER_LIST_MODIFY` (28944) exists in the reference packet names but is **implemented by neither side**: the client ignores it. Presence updates are therefore sent as a full `UserList` (the same packet the refresh button produces):

- batched every **750 ms**, so 100 logins in one second become one send;
- sent only to users in the lobby (`roomId === null`);
- one buffer built and written to N sockets.

Paging: `fields[0]` is the total count; the server sends only the 10 rows of the requested page (the C# sent everyone and let the client page locally). Each session remembers its last requested page for pushes.

## Chat (29696)

```
client: id=29696 fields=[type, targetId, targetName, "Nick>>text"]
```

The message is `"<nick>>>\x1D<text>"` with spaces already escaped.

| type | name | how the client renders it |
|---|---|---|
| 1 | Notice1 | **notice popup** (same client function as 2), unusable for frequent messages |
| 2 | Notice2 | **notice popup**; `/notice` uses it for players in the lobby |
| 3 | LobbyToChannel | chat line |
| 4 | Room_ToAll | chat line; colour by `targetId` (below) |
| 6 | Whisper | private chat line |
| 8 | LobbyToAll | chat line |
| 10 | Clan | clan chat line |

- **Client 22 handler** (decompiled `0x7400`, `FUN_005edcd0`): it prints the **message field as-is**, so the `Nick>> ` prefix is whatever the sender wrote. The server therefore rebuilds it from the sender's real nickname before forwarding.
- Room line colour (type 4, outside a match) by `targetId`: `999` yellow (system), `997`/`998` light blue (used for GM lines), anything else white. During a match lines use team colours.
- The client reads at most 512 bytes per field. Its error-reply path (first field not `0`/`1`, e.g. `95040` + name) copies that string into a 128-byte buffer: never send long strings in chat error replies.
- Server-side limits: text after `>>` at most 60 characters, target name at most 16, 5 messages per 5 s per player (a warning whisper instead of the 6th); a message without the `>>` marker is dropped.
- System messages use type 4 with `targetId=999` and the `System>> ` prefix: yellow text, no popup.
- **The `>>` marker is needed on every line**; without it the client renders only the last `<...>` token.
- GM replies are whispers (type 6) with the recipient's sessionId/name in the target fields.
- **Line length**: the input box allows 55 characters; long lines (hundreds of chars) are lost on receive. Server text is split into several `CHAT` packets with `MAX_CHAT_LINE = 50`: `wrapLines` for free text, `packItems` for lists of whole entries.

## Rooms

A single 25-field "room description" is reused by `RoomCreation`, `RoomList`, `RoomJoin`, `RoomUpdate` and `RoomSpectate`.

### Creation (29440)

```
IN  blocks=[OneShot,OneKill, 0, NULL, 1, 12, 3, 0, 0]
OUT fields=[1, 0, 1, 1, 1, 0, OneShot,OneKill, 0, 16, 1, 1, 0, 2, 0, 2, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, -1]
```

`blocks[0]` is the name; `blocks[3]` is a capacity **index** (CQC channel: index 1 = `8 x (1+1)` = 16 players).

- Default `setting` is `0` (one round in Explosive). The client never sends `CHANGE_ROUNDS`/`CHANGE_KILLS` for an untouched field.
- Room ids are **0-based** and the smallest free id is reused.
- The "master" field is a slot index, not a sessionId.

### Room list (29184) and updates (29200)

- `ROOM_LIST` request: paged (direction computed from two fields), optional `waitingOnly`; answered only when the requester is not in a room.
- `ROOM_LIST_UPDATE` (29200): incremental update pushed to the lobby.
- A player returning to the lobby gets a full `RoomList`: the client ignores incremental updates until its list is reloaded.

### Join and teams (29456)

**The team is encoded in the slot**: the lower half of the slots (0-7 of 16) is team 0, the upper half (8-15) is team 1. A team change moves the player to a free slot in the right half. In the reply the header slot is the **old** slot (read on arrival); the new slot is only in the payload.

### Invite (29520)

```
OUT id=29520 fields=[<target nick>, come here]
IN  id=29520 blocks=[1, 0, -1, 3410, 3410, <inviter>, -1, -1, -1, -1, 1, 18, 37765155, 3, 0, -1, comehere, 1, NULL]
```

The accepting client reads the **password right after the message** (where the C# puts the room id) and never reads the room id: it joins with `roomId=0`, a sentinel for "the room I was last invited to". The server stores `pendingInviteRoomId` on the invited user and falls back to it when room 0 does not exist. Invites target the **display name**, not the login name.

### Kick (29505)

Send only the notification to the target. The real client then sends its own `RoomLeave`, which does the cleanup. Removing the player server-side first made the client crash, because its `RoomLeave` got no reply.

### Leave (29504)

`RoomLeave` is sent to the leaving player **and** broadcast to those who stay. Fields: the third is the slot the player held; the last two are XP and money after payout.

- Every exit path (voluntary, kick, disconnect, crash) goes through `removeFromRoom`, which does the broadcast.
- If the master leaves, a new master is chosen by priority `1 + premium`, scanning slots in order; the new master is set ready.
- Order: broadcast to remaining players, reply to the leaver, **then** the lobby update.

### Entry lock (GameSub 58)

Host toggle separate from capacity. Joining a locked room returns `94060` (`UsersExceeded`), a full room `94120` (`RoomIsFull`).

### Room roster: `PLAYER_INFO` (29952)

Sent **only on room join**, and **never to a player about themselves**. Resending it mid-match resets the shooter's HUD (it re-renders their class). `kills`/`deaths` in it are **lifetime** account stats; `class` is the class from the last spawn.

**Own entry in PLAYER_INFO (0x7500).** After a room creation or a join the server sends the full player list, the receiver's own entry included. Client 22 loads a player's clan emblem only while parsing PLAYER_INFO (clan id > 0 → emblem download, see [clans](clans.md)); without its own entry a player saw everyone's emblem but their own (grey placeholder).
