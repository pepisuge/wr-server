// Ported from Game/Handlers/UserList.cs + Game/Packets/UserList.cs (opcode
// 28928). A self-designed incremental-push variant on USER_LIST_MODIFY
// (28944, a real never-implemented opcode name - see the guide) was tried
// first and the real client silently ignored it. Confirmed working instead:
// re-sending the exact same 28928 packet the client's own "refresh" click
// produces - so that's what a presence change pushes now, just proactively
// instead of waiting to be asked.
const { users } = require('./state');
const { clanInfo } = require('./clan');

const USER_LIST = 0x7100;

// Shared by every USER_LIST send (on-demand and pushed), so they never
// drift apart. Matches Packets/UserList.cs field-for-field (including the
// odd "0 if in a clan, else -1" trailing clan field, not the repeated-rank
// convention Authorization.cs uses).
function userListEntry(u, index) {
  const clan = clanInfo(u);
  return [
    index,
    u.id,
    u.sessionId,
    u.displayname,
    ...(clan ? [clan.id, clan.name, clan.rank, 0] : [-1, -1, -1, -1]),
    0,
    16,
    u.xp,
    u.premium,
    0,
  ];
}

function buildUserListFields(page) {
  const list = [...users.values()];
  const fields = [list.length, page];
  const start = page * 10;
  list.slice(start, start + 10).forEach((u, i) => fields.push(...userListEntry(u, start + i)));
  return fields;
}

function handleUserList(socket, pkt) {
  const page = Number(pkt.blocks[0]) || 0;
  socket.user.userListPage = page; // remembered so a later push re-sends the page they're actually looking at
  socket.sendPacket(USER_LIST, buildUserListFields(page));
}

// Batches connect/disconnect events instead of pushing on every single one:
// under a burst (e.g. everyone reconnecting after a restart), N events each
// re-sending the full list to every lobby user is O(n^2) work in a tight
// window - one flush per 750ms window bounds that to at most one full round
// per window, however many events happened inside it. Audience is capped to
// players not currently in a room - same "lobby-only" scoping rooms.js
// already uses for room-list pushes - since a mid-match player has no use
// for "someone just logged in" and that's also when the server is busiest
// with other traffic (UDP relay, GameTick).
const BATCH_MS = 750;
let dirty = false;
let flushTimer = null;

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, BATCH_MS);
}

function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;

  for (const u of users.values()) {
    if (u.roomId !== null) continue;
    u.socket.sendPacket(USER_LIST, buildUserListFields(u.userListPage || 0));
  }
}

function announceJoin() {
  scheduleFlush();
}

function announceLeave() {
  scheduleFlush();
}

module.exports = { handleUserList, announceJoin, announceLeave, USER_LIST };
