// Fase 45: this was NOT self-designed after all - see the guide. CLAN_SYSTEM
// (0x6710, 26384) is a real handler in WarRock-ToXiiC-Core (Game/Clan.cs's
// CP_Clan, Managers/ClanManager.cs), cabled to real DB mutations.
// Chapter-1-Server's Managers/ClanManager.cs is read-only display code with
// zero mutation handler - the two references disagree on completeness
// exactly like the GM commands did (CLAUDE.md's own example of this
// pattern), and this file previously took Chapter-1's silence as "nobody
// implements this."
//
// Ported field-for-field from ToXiiC-Core (subtype numbers, rank model,
// reply shapes) onto the DB schema actually in use here (Chapter-1's
// `clan`/`user_details` - different tables/columns than ToXiiC's own
// `clans`/`clans_invite`/`clans_clanwars`). Columns ToXiiC has that this
// schema doesn't (exp, iconid, per-member join date, a real max-member cap)
// are sent as fixed/derived values on the wire - documented per call site
// below - rather than adding new columns for a v1 port.
const { users } = require('./state');
const { ownsItem, buildItemlist } = require('./inventory');
const { removeItem } = require('./shop');

// Lazy on purpose (called from inside functions below, not required at
// module top): chat.js requires gm.js, which requires rooms.js, which
// requires clan.js for clanInfo - a top-level require here would close that
// cycle and silently hand gm.js's own rooms.js imports `undefined` (found
// live: 5 of gm.js's destructured rooms.js exports broke this way).
function chat() {
  return require('./chat');
}

const CLAN_SYSTEM = 0x6710;
const CLAN_RANKING = 0x6760;

// Real subtype numbers from ToXiiC's CP_Clan.Subtype enum - NOT a design
// choice, this is the actual wire protocol. NickChange(12) is now ported
// (below, CB02). ChangeAnnDec(8)/MarkChange(14)/NewSearchClan(17) still need
// a column this schema doesn't have (CB54 for MarkChange isn't even in
// item_extra) - left unhandled like any other out-of-scope subtype.
const SUB = {
  CHECK_NAME: 0,
  CREATE: 1,
  APPLY: 2,
  LEAVE: 3,
  MY_CLAN: 4,
  MEMBERS: 5,
  SEARCH: 6,
  INFO: 7,
  JOIN_ACTION: 9,
  RANK_ACTION: 10,
  PROMOTE: 11,
  NICK_CHANGE: 12, // renames the CLAN (item CB02) - unrelated to a player's own nickname (shop.js's CB01)
  DISBAND: 16,
  // Not a real subtype - out of the real 0-17 range on purpose. Clan war is
  // still self-designed (see handleStartWar below); previously this reused
  // subtype 6, which the real protocol also uses for SearchClan.
  START_WAR: 1000,
};

// Real rank model (ToXiiC's `clanrank` values). Replaces this file's old
// invented 0/1 model, which collided master and officer into ">= 1" and let
// an officer disband the clan, and had no concept of a pending applicant.
const RANK = { MEMBER: 0, OFFICER: 1, MASTER: 2, PENDING: 9 };

// Shown in game and, later, on the website: letters, digits, _ and - only, 5-20 long.
const CLAN_NAME_RE = /^[A-Za-z0-9_-]{5,20}$/;

const CREATE_COST = 10000; // Configs/Server.cs's Clan.CreationCost default
const MAX_MEMBERS = 20; // ToXiiC's AddClan insert hardcodes maxusers=20; no upgrade path (UpgradeClan) ported
const CLAN_ICON = 1001001; // ToXiiC's AddClan default iconid - no `iconid` column here to persist a real choice

// Same pattern as gm.js's setAuthDb: displayname lives in the login DB
// (masterserver.users), not this process's own `db` pool (wres2) - needed
// for member/pending/search lists and the master's name, none of which
// ToXiiC needs a second pool for since its schema keeps everything in one
// `users` table.
let authDb = null;
function setAuthDb(pool) {
  authDb = pool;
}

// In-memory mirror of the `clan` table, same Map-of-state pattern as
// state.js's channels/rooms. Clan id 0 is the schema's reserved "blank"/
// disbanded row and is never loaded - it's how we spell "no clan".
const clans = new Map(); // clanId -> { id, name, master, members, wins, losses, dateCreation, eslogan }

async function loadClans(db) {
  const [rows] = await db.query(
    'SELECT id, name, master, members, wins, losses, date_creation, eslogan FROM clan WHERE disbanded = 0 AND validated = 1 AND id > 0'
  );
  for (const r of rows) {
    clans.set(r.id, {
      id: r.id,
      name: r.name,
      master: r.master,
      members: r.members,
      wins: r.wins,
      losses: r.losses,
      dateCreation: r.date_creation,
      eslogan: r.eslogan,
    });
  }
}

// Used by rooms.js/handlers.js/userlist.js to fill the clan fields other
// packets already have slots for (RoomPlayers/Authorization/UserList).
function clanInfo(u) {
  const clan = u.clanId > 0 ? clans.get(u.clanId) : null;
  return clan ? { id: clan.id, name: clan.name, rank: u.clanRank } : null;
}

// Online members, derived live from state.js's users - same source chat.js's
// CLAN chat broadcast already uses.
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

// No `exp` column in this schema (ToXiiC awards +1000/+500/+250 per clan-war
// outcome, tracked nowhere here yet - clan war is still self-designed, see
// the guide). Approximated from wins so ranking/MyClan/ClanRanking have a
// non-constant number to sort/display instead of a placeholder zero.
function clanExp(clan) {
  return clan.wins * 250;
}

function clanRankingIndex(clanId) {
  const sorted = [...clans.values()].sort((a, b) => clanExp(b) - clanExp(a));
  return sorted.findIndex((c) => c.id === clanId) + 1;
}

function formatDate(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

async function fetchXp(db, userId) {
  const [rows] = await db.query('SELECT xp FROM user_details WHERE id = ?', [userId]);
  return rows[0] ? Number(rows[0].xp) : 0;
}

// Batch displayname lookup against the login DB (masterserver.users) - see
// setAuthDb above for why this needs a second pool.
async function resolveDisplaynames(ids) {
  if (!authDb || ids.length === 0) return new Map();
  const [rows] = await authDb.query('SELECT id, displayname FROM users WHERE id IN (?)', [ids]);
  return new Map(rows.map((r) => [r.id, r.displayname]));
}

// Subtype 0 - Game/Clan.cs:46-54. Silently ignored below the length check,
// matching the reference exactly (the client's own create-clan form enforces
// this before letting the player submit).
function handleCheckName(socket, payload) {
  const name = (payload[0] || '').replace(/ /g, '');
  if (!CLAN_NAME_RE.test(name)) return;
  const exists = [...clans.values()].some((c) => c.name.toLowerCase() === name.toLowerCase());
  sendReply(socket, SUB.CHECK_NAME, [exists ? 62003 : 1]);
}

// Subtype 12 - Game/Clan.cs:404-428, item CB02. Ported as-is including the
// reference's own quirk: if the new name is free but the caller doesn't own
// CB02, nothing is sent back at all (not even an error) - the same silent
// no-op as the reference, not "fixed" here.
function handleNickChange(socket, db, payload) {
  const u = socket.user;
  if (!(u.clanId > 0)) return;
  const clan = clans.get(u.clanId);
  if (!clan) return;

  const newName = (payload[0] || '').replace(/ /g, '');
  if (!CLAN_NAME_RE.test(newName)) return chat().sendSystemWhisper(socket, 'Clan names: 5-20 letters, digits, _ or -.');
  if ([...clans.values()].some((c) => c.name.toLowerCase() === newName.toLowerCase())) {
    return chat().sendSystemWhisper(socket, 'A clan has already this name, please choose another one');
  }
  if (!ownsItem(u.inventory, 'CB02')) return;

  clan.name = newName;
  persist(db, 'UPDATE clan SET name = ? WHERE id = ?', [newName, clan.id]);
  removeItem(db, u, 'CB02');
  // Real reply shape, Clan.cs's own Change(usr, true): [12, 1, itemlist] -
  // confirms the item is gone, same idea as shop.js's own post-purchase resync.
  sendReply(socket, SUB.NICK_CHANGE, [1, buildItemlist(u.inventory)]);
}

// Subtype 1 - Managers/ClanManager.cs:141-187. The `id` is left to the
// schema's own AUTO_INCREMENT (read back via insertId) instead of this
// file's old nextFreeClanId() scan, which reused ids off disbanded rows
// (disbanded=1 rows are never deleted) and silently lost a clan to a
// duplicate-key error on every restart after the first disband.
async function handleCreate(socket, db, payload) {
  const u = socket.user;
  const name = (payload[0] || '').replace(/ /g, '');
  if (!CLAN_NAME_RE.test(name)) return chat().sendSystemWhisper(socket, 'Clan names: 5-20 letters, digits, _ or -.');

  if (u.clanId > 0) return chat().sendSystemWhisper(socket, 'Cannot create the clan because you are in a clan!');
  if ([...clans.values()].some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return chat().sendSystemWhisper(socket, 'Cannot create the clan because this clan name is already in use!');
  }
  if (u.money < CREATE_COST) return chat().sendSystemWhisper(socket, `You havent enough dinars (${CREATE_COST} needed!)`);

  const tag = name.slice(0, 4).toUpperCase(); // schema's `tag` is NOT NULL; the real protocol never transmits one
  const dateCreation = Math.floor(Date.now() / 1000);
  const [result] = await db.query(
    'INSERT INTO clan (name, members, tag, wins, losses, draws, master, recruitment, disbanded, validated, date_creation, eslogan) VALUES (?, 1, ?, 0, 0, 0, ?, 0, 0, 1, ?, NULL)',
    [name, tag, u.id, dateCreation]
  );
  const clanId = result.insertId;

  u.money -= CREATE_COST;
  u.clanId = clanId;
  u.clanRank = RANK.MASTER;
  clans.set(clanId, { id: clanId, name, master: u.id, members: 1, wins: 0, losses: 0, dateCreation, eslogan: null });

  persist(db, 'UPDATE user_details SET money = GREATEST(0, CAST(money AS SIGNED) - ?), clanid = ?, clanrank = ? WHERE id = ?', [CREATE_COST, clanId, RANK.MASTER, u.id]);

  sendReply(socket, SUB.CREATE, [1, clanId, 2, name, u.money]);
}

// Subtype 2 - Game/Clan.cs:64-96. Unlike this file's old JOIN, membership
// isn't instant: the applicant is parked at clanrank=PENDING until a
// master/officer accepts via JOIN_ACTION (subtype 9).
async function handleApply(socket, db, payload) {
  const u = socket.user;
  const clanId = Number(payload[0]);
  if (!(clanId > 0) || u.clanId > 0) return;
  const clan = clans.get(clanId);
  if (!clan || clan.members >= MAX_MEMBERS) return;

  u.clanId = clanId;
  u.clanRank = RANK.PENDING;
  persist(db, 'UPDATE user_details SET clanid = ?, clanrank = ? WHERE id = ?', [clanId, RANK.PENDING, u.id]);

  sendReply(socket, SUB.APPLY, [1]);
}

// Shared by LEAVE-as-master and DISBAND. Notice must go out to members
// BEFORE clearing their clanId - onlineMembers()/chat().sendClanNotice() both
// filter live state by clanId, so calling this first would leave the notice
// with zero recipients.
function disbandClan(db, clan) {
  clans.delete(clan.id);
  for (const member of onlineMembers(clan.id)) {
    member.clanId = 0;
    member.clanRank = RANK.MEMBER;
  }

  persist(db, 'UPDATE clan SET disbanded = 1 WHERE id = ?', [clan.id]);
  persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE clanid = ?', [clan.id]);
}

// Subtype 3 - Game/Clan.cs:97-143.
function handleLeave(socket, db) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return;

  if (u.clanRank === RANK.MASTER) {
    // Faithful to the reference: leaving as master silently disbands the
    // clan here - no SP_Clan reply, no member notice - unlike DISBAND
    // (subtype 16), which sends both. Looks like an inconsistency in the
    // reference itself, not something to "fix" without a real capture
    // showing otherwise (see CLAUDE.md: confirmed-complete areas are ported
    // faithfully, not improved on speculatively).
    disbandClan(db, clan);
    return;
  }

  const wasPending = u.clanRank === RANK.PENDING;
  u.clanId = 0;
  u.clanRank = RANK.MEMBER;
  if (!wasPending) {
    clan.members--;
    persist(db, 'UPDATE clan SET members = ? WHERE id = ?', [clan.members, clan.id]);
  }
  persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE id = ?', [u.id]);

  sendReply(socket, SUB.LEAVE, [1]);
}

// Subtype 16 - Managers/ClanManager.cs:189-225.
function handleDisband(socket, db) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return;
  if (u.clanRank !== RANK.MASTER) return chat().sendSystemWhisper(socket, "Cannot delete the clan because you're not the master!");

  chat().sendClanNotice(clan.id, `${u.displayname} disbanded the clan :(`);
  disbandClan(db, clan);
  sendReply(socket, SUB.DISBAND, [1]);
}

// Subtype 4 - Game/Clan.cs:144-149, SP_Clan.MyClanInformation. Replaces this
// file's old DISBAND-on-subtype-4 bug: 4 is "open my clan panel", not
// disband - a master opening their own clan tab used to delete it outright.
async function handleMyClan(socket, db) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return;

  const masterXp = await fetchXp(db, clan.master);
  const names = await resolveDisplaynames([clan.master]);
  const [pendingRows] = await db.query('SELECT COUNT(*) AS count FROM user_details WHERE clanid = ? AND clanrank = ?', [clan.id, RANK.PENDING]);

  sendReply(socket, SUB.MY_CLAN, [
    1,
    u.clanRank,
    clan.name,
    names.get(clan.master) || '??',
    masterXp,
    0, // Count = maxUsers/20 - 1: always 0, no upgrade path (UpgradeClan) ported
    clan.members,
    pendingRows[0].count > 0 ? 1 : 0,
    clan.wins,
    clan.losses,
    clanExp(clan),
    clanRankingIndex(clan.id),
    0,
    clan.eslogan || '',
    '', // Announcment: no separate column in this schema (only `eslogan`)
    CLAN_ICON,
    0, // clan-war history length: not tracked yet, see the guide
  ]);
}

async function sendMemberList(socket, clan, rows) {
  const names = await resolveDisplaynames(rows.map((r) => r.id));
  // No per-member join date in this schema (ToXiiC's `users.clanjoindate`
  // has no equivalent column here) - approximated with the clan's own
  // creation date for every row, a documented deviation not a real date.
  const joinDate = formatDate(clan.dateCreation);
  const fields = [1, rows.length];
  for (const r of rows) fields.push(r.id, r.clanrank, Number(r.xp), names.get(r.id) || '??', joinDate, joinDate, 36);
  sendReply(socket, SUB.MEMBERS, fields);
}

// Subtype 5 - Game/Clan.cs:150-166. page=1 is the roster, page=2 is the
// pending-applicants queue (master/officer only).
async function handleMembers(socket, db, payload) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return;
  const page = Number(payload[0]);

  if (page === 1) {
    const [rows] = await db.query(
      'SELECT id, clanrank, xp FROM user_details WHERE clanid = ? AND clanrank IN (0,1,2) ORDER BY clanrank DESC',
      [clan.id]
    );
    return sendMemberList(socket, clan, rows);
  }
  if (page === 2 && (u.clanRank === RANK.OFFICER || u.clanRank === RANK.MASTER)) {
    const [rows] = await db.query('SELECT id, xp FROM user_details WHERE clanid = ? AND clanrank = ?', [clan.id, RANK.PENDING]);
    return sendMemberList(socket, clan, rows.map((r) => ({ ...r, clanrank: RANK.PENDING })));
  }
}

// Subtype 7 - Game/Clan.cs:206-218, SP_Clan.UserList.NormalUser(User, Clan).
async function handleInfo(socket, db, payload) {
  const clanId = Number(payload[0]);
  if (!(clanId > 0)) return;
  const clan = clans.get(clanId);
  if (!clan) return;

  const names = await resolveDisplaynames([clan.master]);
  sendReply(socket, SUB.INFO, [
    1,
    clan.id,
    clan.name,
    names.get(clan.master) || '??',
    await fetchXp(db, clan.master),
    0,
    clan.members,
    clan.eslogan || '',
    CLAN_ICON,
  ]);
}

// Subtype 6 - Game/Clan.cs:167-205, the SearchType.Name/Master branch (basic
// list, not the paginated/sorted NewSearchClan variant - subtype 17, not
// ported). getBlock(1) is read as both search-type and key in the
// reference's own code (a copy-paste bug there); the real key is
// getBlock(2), i.e. payload[1] here.
async function handleSearch(socket, db, payload) {
  const key = (payload[1] || '').toLowerCase();
  if (key.length < 3) return sendReply(socket, SUB.CHECK_NAME, [63001]); // NotFound - reference replies on CheckClan's shape for this case too
  const matches = [...clans.values()].filter((c) => c.name.toLowerCase().includes(key));
  const names = await resolveDisplaynames(matches.map((c) => c.master));
  const fields = [1, matches.length];
  for (const c of matches) fields.push(c.id, names.get(c.master) || '??', await fetchXp(db, c.master), c.name, 0, c.members, CLAN_ICON);
  sendReply(socket, SUB.SEARCH, fields);
}

// Subtype 9 - Game/Clan.cs:242-317, the Accept(0)/Refuse(1) branches.
// Deviation from the reference: it never checks the target is actually a
// pending applicant to THIS clan before mutating them - trusts the caller's
// targetId completely, which lets any officer of any clan "refuse" (i.e.
// blank out the clanid/clanrank of) an arbitrary account. Both the DB
// update and the in-memory mutation below are scoped to a target that's
// actually PENDING in this clan; an offline target still updates by id
// alone (no online record to check against), same trust level the
// reference has for that case.
async function handleJoinAction(socket, db, payload) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return;
  if (u.clanRank !== RANK.OFFICER && u.clanRank !== RANK.MASTER) return;

  const action = Number(payload[0]);
  const targetId = Number(payload[1]);
  const target = [...users.values()].find((x) => x.id === targetId);
  if (target && !(target.clanId === clan.id && target.clanRank === RANK.PENDING)) return;

  if (action === 0) {
    if (clan.members >= MAX_MEMBERS) {
      return chat().sendSystemWhisper(socket, 'No more slot available for the clan, please expand if is possible');
    }
    clan.members++;
    persist(db, 'UPDATE clan SET members = ? WHERE id = ?', [clan.members, clan.id]);
    persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ? AND clanid = ? AND clanrank = ?', [RANK.MEMBER, targetId, clan.id, RANK.PENDING]);
    if (target) target.clanRank = RANK.MEMBER;
  } else if (action === 1) {
    persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE id = ? AND clanid = ? AND clanrank = ?', [targetId, clan.id, RANK.PENDING]);
    if (target) {
      target.clanId = 0;
      target.clanRank = RANK.MEMBER;
    }
  } else {
    return;
  }

  sendReply(socket, SUB.JOIN_ACTION, [action, targetId]);
}

// Subtype 10 - Game/Clan.cs:318-369. Promote-to-officer(0)/demote(1)/kick(2).
// Ported as-is including the reference's own permission model (any officer
// or master can act on any member, with no extra check that the target
// isn't e.g. the master themselves) - except, like JOIN_ACTION above, both
// the DB update and the in-memory mutation are scoped to a target that's
// actually a member of THIS clan, which the reference never verifies.
function handleRankAction(socket, db, payload) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return;
  if (u.clanRank !== RANK.OFFICER && u.clanRank !== RANK.MASTER) return;

  const action = Number(payload[0]);
  const targetId = Number(payload[1]);
  const target = [...users.values()].find((x) => x.id === targetId);
  if (target && target.clanId !== clan.id) return;

  if (action === 0) {
    persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ? AND clanid = ?', [RANK.OFFICER, targetId, clan.id]);
    if (target) target.clanRank = RANK.OFFICER;
  } else if (action === 1) {
    persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ? AND clanid = ?', [RANK.MEMBER, targetId, clan.id]);
    if (target) target.clanRank = RANK.MEMBER;
  } else if (action === 2) {
    clan.members--;
    persist(db, 'UPDATE clan SET members = ? WHERE id = ?', [clan.members, clan.id]);
    persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE id = ? AND clanid = ?', [targetId, clan.id]);
    if (target) {
      target.clanId = 0;
      target.clanRank = RANK.MEMBER;
    }
  } else {
    return;
  }

  sendReply(socket, SUB.RANK_ACTION, [action, targetId]);
}

// Subtype 11 - Game/Clan.cs:370-403, master hand-off.
async function handlePromote(socket, db, payload) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan) return;
  // Deviation from the reference: Game/Clan.cs:370-403 has NO rank check at
  // all here - any clan member could call this and reassign the clan's own
  // master to anyone. Every sibling master-only action in this same file
  // (LeaveClan-as-master, DisbandClan) requires clanRank==MASTER; treating
  // the omission here as a reference bug rather than intended design, and
  // requiring master rank like those do (see CLAUDE.md on prioritizing safe,
  // correct code).
  if (u.clanRank !== RANK.MASTER) return;

  const targetId = Number(payload[0]);
  if (targetId === u.id) return;
  const target = [...users.values()].find((x) => x.id === targetId);
  if (target && target.clanId !== clan.id) return;

  clan.master = targetId;
  u.clanRank = RANK.MEMBER;
  if (target) target.clanRank = RANK.MASTER;

  persist(db, 'UPDATE clan SET master = ? WHERE id = ?', [targetId, clan.id]);
  persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ?', [RANK.MEMBER, u.id]);
  persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ? AND clanid = ?', [RANK.MASTER, targetId, clan.id]);

  const names = await resolveDisplaynames([targetId]);
  chat().sendClanNotice(clan.id, `${u.displayname} passed master to ${names.get(targetId) || '??'} :/`);
  sendReply(socket, SUB.PROMOTE, [1]);
}

// Clan war, still designed from scratch - see the guide: the reference has
// isClanWar/Clan1/Clan2 wire fields and Room.cs code that keys off them, but
// no CLAN_SYSTEM subtype anywhere ever triggers it (a real client likely
// starts one through a different, still-unidentified path, maybe
// RoomCreation's own fields directly). SUB.START_WAR (1000) is a synthetic
// number chosen to not collide with any real subtype, not a captured value.
// Only a clan master/officer can declare war; no accept/decline handshake in
// this first cut - the room exists immediately.
// require('./rooms') is deliberately lazy (inside the function, not at
// module top) - rooms.js itself requires clan.js for clanInfo, and calling
// through the cycle only after both modules have finished loading (i.e.
// inside a handler, not at require-time) is what keeps it safe.
function handleStartWar(socket, db, payload) {
  const u = socket.user;
  const clan = clans.get(u.clanId);
  if (!clan || (u.clanRank !== RANK.MASTER && u.clanRank !== RANK.OFFICER)) return sendReply(socket, SUB.START_WAR, [0]);

  const opponentId = Number(payload[0]);
  const opponent = clans.get(opponentId);
  if (!opponent || opponentId === u.clanId) return sendReply(socket, SUB.START_WAR, [0]);

  const { createClanWarRoom } = require('./rooms');
  const room = createClanWarRoom(u, opponentId);

  chat().sendClanNotice(opponentId, `${clan.name} ha dichiarato guerra al tuo clan! Stanza #${room.id} pronta.`);

  sendReply(socket, SUB.START_WAR, [1, room.id]);
}

function handleClanSystem(db) {
  return (socket, pkt) => {
    if (!socket.user) return;
    const subType = Number(pkt.blocks[0]);
    const payload = pkt.blocks.slice(1);

    if (subType === SUB.CHECK_NAME) return handleCheckName(socket, payload);
    if (subType === SUB.CREATE) return handleCreate(socket, db, payload);
    if (subType === SUB.APPLY) return handleApply(socket, db, payload);
    if (subType === SUB.LEAVE) return handleLeave(socket, db);
    if (subType === SUB.MY_CLAN) return handleMyClan(socket, db);
    if (subType === SUB.MEMBERS) return handleMembers(socket, db, payload);
    if (subType === SUB.SEARCH) return handleSearch(socket, db, payload);
    if (subType === SUB.INFO) return handleInfo(socket, db, payload);
    if (subType === SUB.JOIN_ACTION) return handleJoinAction(socket, db, payload);
    if (subType === SUB.RANK_ACTION) return handleRankAction(socket, db, payload);
    if (subType === SUB.PROMOTE) return handlePromote(socket, db, payload);
    if (subType === SUB.NICK_CHANGE) return handleNickChange(socket, db, payload);
    if (subType === SUB.DISBAND) return handleDisband(socket, db);
    if (subType === SUB.START_WAR) return handleStartWar(socket, db, payload);
  };
}

// Real opcode 26464 (Game/ClanRanking.cs). No `db` needed - reads straight
// from the already-in-memory `clans` Map, which ToXiiC's own once-an-hour DB
// re-query (ClanRanking.LastUpdate) exists only to avoid; not needed here.
function handleClanRanking(socket) {
  if (!socket.user || socket.user.roomId !== null) return; // matches `if (usr.room != null) return;`
  const sorted = [...clans.values()].sort((a, b) => clanExp(b) - clanExp(a)).slice(0, 30);
  const fields = [1, new Date().getUTCHours() + 1, sorted.length];
  for (const c of sorted) fields.push(CLAN_ICON, c.name, clanExp(c), c.members, MAX_MEMBERS);
  socket.sendPacket(CLAN_RANKING, fields);
}

module.exports = { CLAN_SYSTEM, CLAN_RANKING, SUB, RANK, loadClans, clanInfo, handleClanSystem, handleClanRanking, setAuthDb };
