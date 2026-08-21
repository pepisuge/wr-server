// Fase 7 - clan system. Unlike every other module here, this isn't ported
// from the C# reference: CLAN_SYSTEM (0x6710) exists as an opcode number in
// txt/Packets.txt but is never read or written anywhere in the reference
// code (see the guide's Fase 7 section) - no handler, no sub-action layout,
// no wire format to copy. Everything below - the sub-type numbers, the
// payload shapes, the reply shapes - is designed from scratch against only
// the `clan` table and `user_details.clanid/clanrank`, and is UNTESTED
// against the real client until it's actually exercised live. Expect to
// revise this once real captures show what the client sends/expects.
const { users } = require('./state');

const CLAN_SYSTEM = 0x6710;
const SUB = { CREATE: 1, JOIN: 2, LEAVE: 3, DISBAND: 4, MEMBERS: 5, START_WAR: 6 };

// In-memory mirror of the `clan` table, same Map-of-state pattern as
// state.js's channels/rooms. Clan id 0 is the schema's reserved "blank"/
// disbanded row and is never loaded - it's how we spell "no clan".
const clans = new Map(); // clanId -> { id, name, tag, master }

async function loadClans(db) {
  const [rows] = await db.query('SELECT id, name, tag, master FROM clan WHERE disbanded = 0 AND validated = 1 AND id > 0');
  for (const r of rows) clans.set(r.id, { id: r.id, name: r.name, tag: r.tag, master: r.master });
}

// Used by rooms.js/handlers.js to fill the clan fields other packets
// already have slots for (RoomPlayers/Authorization).
function clanInfo(u) {
  const clan = u.clanId > 0 ? clans.get(u.clanId) : null;
  return clan ? { id: clan.id, name: clan.name, rank: u.clanRank } : null;
}

// Online members, derived live from state.js's users - same source chat.js's
// CLAN chat broadcast already uses. Not tracked as a separate Set: a Set
// populated only at create/join time goes stale the moment a member
// reconnects with a new session (found while testing clan war's notify -
// disbandClan/handleMembers had the same latent bug before this fix).
function onlineMembers(clanId) {
  return [...users.values()].filter((u) => u.clanId === clanId);
}

function sendReply(socket, subType, payload) {
  socket.sendPacket(CLAN_SYSTEM, [subType, ...payload]);
}

// Fire-and-forget persistence, same pattern as progression.js's
// applyMatchEnd: the in-memory state (source of truth for replies/broadcasts
// within this session) is mutated synchronously before any `await`, so two
// requests from the same client handled back-to-back never race each other
// waiting on the same DB round-trip.
function persist(db, sql, params) {
  db.query(sql, params).catch((err) => console.error('clan: failed to persist:', err.message));
}

// Lowest free clan id, same idea as state.js's nextFreeRoomId - generated
// here (not left to MySQL's AUTO_INCREMENT) so create can update in-memory
// state and reply immediately, persisting the INSERT afterward.
function nextFreeClanId() {
  let id = 1;
  while (clans.has(id)) id++;
  return id;
}

function handleCreate(socket, db, payload) {
  const u = socket.user;
  if (u.clanId > 0) return sendReply(socket, SUB.CREATE, [0]);
  const name = (payload[0] || '').slice(0, 25);
  const tag = (payload[1] || '').slice(0, 10);
  if (!name || !tag) return sendReply(socket, SUB.CREATE, [0]);

  const clanId = nextFreeClanId();
  clans.set(clanId, { id: clanId, name, tag, master: u.id });
  u.clanId = clanId;
  u.clanRank = 1;

  persist(
    db,
    'INSERT INTO clan (id, name, members, tag, wins, losses, draws, master, recruitment, disbanded, validated, date_creation, eslogan) VALUES (?, ?, 1, ?, 0, 0, 0, ?, 0, 0, 1, ?, NULL)',
    [clanId, name, tag, u.id, Math.floor(Date.now() / 1000)]
  );
  persist(db, 'UPDATE user_details SET clanid = ?, clanrank = 1 WHERE id = ?', [clanId, u.id]);

  sendReply(socket, SUB.CREATE, [1, clanId, name, tag]);
}

function handleJoin(socket, db, payload) {
  const u = socket.user;
  if (u.clanId > 0) return sendReply(socket, SUB.JOIN, [0]);
  const clan = clans.get(Number(payload[0]));
  if (!clan) return sendReply(socket, SUB.JOIN, [0]);

  u.clanId = clan.id;
  u.clanRank = 0;

  persist(db, 'UPDATE user_details SET clanid = ?, clanrank = 0 WHERE id = ?', [clan.id, u.id]);
  persist(db, 'UPDATE clan SET members = members + 1 WHERE id = ?', [clan.id]);

  sendReply(socket, SUB.JOIN, [1, clan.id, clan.name, clan.tag]);
}

// Master leaving disbands the clan outright (the simplest of the "master
// leaves" options, not a real leadership hand-off - see the plan).
function disbandClan(db, clan) {
  clans.delete(clan.id);
  for (const member of onlineMembers(clan.id)) {
    member.clanId = 0;
    member.clanRank = 0;
  }

  persist(db, 'UPDATE clan SET disbanded = 1 WHERE id = ?', [clan.id]);
  persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE clanid = ?', [clan.id]);
}

function handleLeave(socket, db) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return sendReply(socket, SUB.LEAVE, [0]);

  if (u.clanRank >= 1) {
    disbandClan(db, clan);
  } else {
    u.clanId = 0;
    u.clanRank = 0;
    persist(db, 'UPDATE clan SET members = members - 1 WHERE id = ?', [clan.id]);
    persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE id = ?', [u.id]);
  }

  sendReply(socket, SUB.LEAVE, [1]);
}

function handleDisband(socket, db) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan || u.clanRank < 1) return sendReply(socket, SUB.DISBAND, [0]);
  disbandClan(db, clan);
  sendReply(socket, SUB.DISBAND, [1]);
}

// ponytail: online members only - offline members live in `user_details` by
// id with no displayname (that's in the separate login-server DB, a
// cross-DB join not worth it for a v1 member list). Add when a real
// "offline roster" UI needs it.
function handleMembers(socket) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return sendReply(socket, SUB.MEMBERS, [0]);
  const members = onlineMembers(u.clanId);
  const fields = [1, members.length];
  for (const m of members) fields.push(m.sessionId, m.displayname, m.clanRank);
  sendReply(socket, SUB.MEMBERS, fields);
}

// Clan war, designed from scratch - see the plan: the reference has
// isClanWar/Clan1/Clan2 fields and wire support for them, but no code path
// anywhere ever creates a room with isClanWar=true. Only a clan master can
// declare war (mirrors disband/create being master-only above); no
// accept/decline handshake in this first cut - the room exists immediately.
// require('./rooms') is deliberately lazy (inside the function, not at
// module top) - rooms.js itself requires clan.js for clanInfo, and calling
// through the cycle only after both modules have finished loading (i.e.
// inside a handler, not at require-time) is what keeps it safe.
function handleStartWar(socket, db, payload) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan || u.clanRank < 1) return sendReply(socket, SUB.START_WAR, [0]);

  const opponentId = Number(payload[0]);
  const opponent = clans.get(opponentId);
  if (!opponent || opponentId === u.clanId) return sendReply(socket, SUB.START_WAR, [0]);

  const { createClanWarRoom } = require('./rooms');
  const room = createClanWarRoom(u, opponentId);

  const notice = `${clan.name} ha dichiarato guerra al tuo clan! Stanza #${room.id} pronta.`;
  for (const member of onlineMembers(opponentId)) {
    member.socket.sendPacket(0x7400, [1, 0, 'GM', 1, 0, 'NULL', `GM>> ${notice}`]);
  }

  sendReply(socket, SUB.START_WAR, [1, room.id]);
}

function handleClanSystem(db) {
  return (socket, pkt) => {
    if (!socket.user) return;
    const subType = Number(pkt.blocks[0]);
    const payload = pkt.blocks.slice(1);

    if (subType === SUB.CREATE) handleCreate(socket, db, payload);
    else if (subType === SUB.JOIN) handleJoin(socket, db, payload);
    else if (subType === SUB.LEAVE) handleLeave(socket, db);
    else if (subType === SUB.DISBAND) handleDisband(socket, db);
    else if (subType === SUB.MEMBERS) handleMembers(socket);
    else if (subType === SUB.START_WAR) handleStartWar(socket, db, payload);
  };
}

module.exports = { CLAN_SYSTEM, SUB, loadClans, clanInfo, handleClanSystem };
