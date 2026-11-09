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

// The lobby user list shows each player's clan and emblem; re-push it after a change (batched in userlist.js).
// Lazy for the same reason as chat(): userlist.js requires this file.
function listChanged() {
  require('./userlist').refreshUserList();
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
const clans = new Map(); // clanId -> { id, name, master, members, wins, losses, draws, dateCreation, eslogan, emblem, emblemData }

async function loadClans(db) {
  const [rows] = await db.query(
    'SELECT id, name, master, members, wins, losses, draws, date_creation, eslogan, emblem, emblem_data FROM clan WHERE disbanded = 0 AND validated = 1 AND id > 0'
  );
  for (const r of rows) {
    clans.set(r.id, {
      id: r.id,
      name: r.name,
      master: r.master,
      members: r.members,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      dateCreation: r.date_creation,
      eslogan: r.eslogan,
      emblem: r.emblem,
      emblemData: r.emblem_data,
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

// No `exp` column in this schema: derived from the war record with ToXiiC's per-war awards
// (win +1000, draw +500, loss +250), so ranking/MyClan/ClanRanking and the site agree.
function clanExp(clan) {
  return clan.wins * 1000 + clan.draws * 500 + clan.losses * 250;
}

// Clan war result (rooms with isClanWar, see roundtimer.js): winner = clan id, or null for a draw.
function recordWar(db, clan1, clan2, winner) {
  for (const id of [clan1, clan2]) {
    const c = clans.get(id);
    if (!c) continue;
    const col = winner === null ? 'draws' : winner === id ? 'wins' : 'losses';
    c[col]++;
    persist(db, `UPDATE clan SET ${col} = ${col} + 1 WHERE id = ?`, [id]);
  }
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

// The acting/target player as clan actions see it: the live user if online (so memory stays in sync), else the DB row.
// The website acts on offline players too, so targets are always checked against this, never trusted by id.
async function memberOf(db, id) {
  const live = [...users.values()].find((x) => x.id === id);
  if (live) return live;
  const [rows] = await db.query('SELECT id, money, clanid, clanrank FROM user_details WHERE id = ?', [id]);
  const r = rows[0];
  return r ? { id: r.id, money: Number(r.money), clanId: r.clanid, clanRank: r.clanrank } : null;
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
// Clan actions shared by the game packets and the website: each returns an error message, or nothing on success.
async function createClan(db, u, name) {
  if (!CLAN_NAME_RE.test(name)) return 'Clan names: 5-20 letters, digits, _ or -.';
  if (u.clanId > 0) return 'Cannot create the clan because you are in a clan!';
  if ([...clans.values()].some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return 'Cannot create the clan because this clan name is already in use!';
  }
  if (u.money < CREATE_COST) return `You havent enough dinars (${CREATE_COST} needed!)`;

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
  clans.set(clanId, { id: clanId, name, master: u.id, members: 1, wins: 0, losses: 0, draws: 0, dateCreation, eslogan: null, emblem: null, emblemData: null });

  persist(db, 'UPDATE user_details SET money = GREATEST(0, CAST(money AS SIGNED) - ?), clanid = ?, clanrank = ? WHERE id = ?', [CREATE_COST, clanId, RANK.MASTER, u.id]);
  listChanged();
}

async function handleCreate(socket, db, payload) {
  const u = socket.user;
  const err = await createClan(db, u, (payload[0] || '').replace(/ /g, ''));
  if (err) return chat().sendSystemWhisper(socket, err);
  sendReply(socket, SUB.CREATE, [1, u.clanId, 2, clans.get(u.clanId).name, u.money]);
}

// Subtype 2 - Game/Clan.cs:64-96. Unlike this file's old JOIN, membership
// isn't instant: the applicant is parked at clanrank=PENDING until a
// master/officer accepts via JOIN_ACTION (subtype 9).
function applyClan(db, u, clanId) {
  if (u.clanId > 0) return 'You are already in a clan.';
  const clan = clans.get(clanId);
  if (!clan) return 'Clan not found.';
  if (clan.members >= MAX_MEMBERS) return 'The clan is full.';

  u.clanId = clanId;
  u.clanRank = RANK.PENDING;
  persist(db, 'UPDATE user_details SET clanid = ?, clanrank = ? WHERE id = ?', [clanId, RANK.PENDING, u.id]);
}

function handleApply(socket, db, payload) {
  if (!applyClan(db, socket.user, Number(payload[0]))) sendReply(socket, SUB.APPLY, [1]);
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
  listChanged();
}

// Subtype 3 - Game/Clan.cs:97-143.
function leaveClan(db, u) {
  const clan = clans.get(u.clanId);
  if (!clan) return 'You are not in a clan.';

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
  listChanged();
}

function handleLeave(socket, db) {
  const wasMaster = socket.user.clanRank === RANK.MASTER;
  if (!leaveClan(db, socket.user) && !wasMaster) sendReply(socket, SUB.LEAVE, [1]);
}

// Subtype 16 - Managers/ClanManager.cs:189-225.
function disbandBy(db, u) {
  const clan = clans.get(u.clanId);
  if (!clan) return 'You are not in a clan.';
  if (u.clanRank !== RANK.MASTER) return "Cannot delete the clan because you're not the master!";

  chat().sendClanNotice(clan.id, `${u.displayname} disbanded the clan :(`);
  disbandClan(db, clan);
}

function handleDisband(socket, db) {
  const err = disbandBy(db, socket.user);
  if (err) return chat().sendSystemWhisper(socket, err);
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

// Subtype 9 - Game/Clan.cs:242-317, Accept(0)/Refuse(1). The reference trusts targetId blindly; here the target
// must be a pending applicant of this clan, online or not.
async function joinAction(db, u, action, targetId) {
  const clan = clans.get(u.clanId);
  if (!clan || (u.clanRank !== RANK.OFFICER && u.clanRank !== RANK.MASTER)) return 'Only the master or an officer can do this.';
  const target = await memberOf(db, targetId);
  if (!target || target.clanId !== clan.id || target.clanRank !== RANK.PENDING) return 'No such applicant.';

  if (action === 0) {
    if (clan.members >= MAX_MEMBERS) return 'No more slot available for the clan, please expand if is possible';
    clan.members++;
    target.clanRank = RANK.MEMBER;
    persist(db, 'UPDATE clan SET members = ? WHERE id = ?', [clan.members, clan.id]);
    persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ? AND clanid = ? AND clanrank = ?', [RANK.MEMBER, targetId, clan.id, RANK.PENDING]);
  } else if (action === 1) {
    target.clanId = 0;
    target.clanRank = RANK.MEMBER;
    persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE id = ? AND clanid = ? AND clanrank = ?', [targetId, clan.id, RANK.PENDING]);
  } else {
    return 'Unknown action.';
  }
  listChanged();
}

async function handleJoinAction(socket, db, payload) {
  const [action, targetId] = [Number(payload[0]), Number(payload[1])];
  const err = await joinAction(db, socket.user, action, targetId);
  if (err) return chat().sendSystemWhisper(socket, err);
  sendReply(socket, SUB.JOIN_ACTION, [action, targetId]);
}

// Subtype 10 - Game/Clan.cs:318-369. Promote-to-officer(0)/demote(1)/kick(2). Unlike the reference, the target must be
// a member or officer of this clan: the master can't be demoted or kicked (that left clans without a master).
// Officers may only kick plain members; rank changes and kicking an officer are the master's (server owner's choice).
async function rankAction(db, u, action, targetId) {
  const clan = clans.get(u.clanId);
  if (!clan || (u.clanRank !== RANK.OFFICER && u.clanRank !== RANK.MASTER)) return 'Only the master or an officer can do this.';
  const target = await memberOf(db, targetId);
  if (!target || target.clanId !== clan.id || (target.clanRank !== RANK.MEMBER && target.clanRank !== RANK.OFFICER)) {
    return 'No such member.';
  }
  if (u.clanRank !== RANK.MASTER && (action !== 2 || target.clanRank === RANK.OFFICER)) return 'Only the master can do this.';

  if (action === 0 || action === 1) {
    target.clanRank = action === 0 ? RANK.OFFICER : RANK.MEMBER;
    persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ? AND clanid = ?', [target.clanRank, targetId, clan.id]);
  } else if (action === 2) {
    clan.members--;
    target.clanId = 0;
    target.clanRank = RANK.MEMBER;
    persist(db, 'UPDATE clan SET members = ? WHERE id = ?', [clan.members, clan.id]);
    persist(db, 'UPDATE user_details SET clanid = 0, clanrank = 0 WHERE id = ? AND clanid = ?', [targetId, clan.id]);
  } else {
    return 'Unknown action.';
  }
  listChanged();
}

async function handleRankAction(socket, db, payload) {
  const [action, targetId] = [Number(payload[0]), Number(payload[1])];
  const err = await rankAction(db, socket.user, action, targetId);
  if (err) return chat().sendSystemWhisper(socket, err);
  sendReply(socket, SUB.RANK_ACTION, [action, targetId]);
}

// Subtype 11 - Game/Clan.cs:370-403, master hand-off. The reference has no rank check at all; here only the master,
// and only to a member/officer of the same clan.
async function promote(db, u, targetId) {
  const clan = clans.get(u.clanId);
  if (!clan || u.clanRank !== RANK.MASTER) return 'Only the master can do this.';
  const target = targetId === u.id ? null : await memberOf(db, targetId);
  if (!target || target.clanId !== clan.id || (target.clanRank !== RANK.MEMBER && target.clanRank !== RANK.OFFICER)) {
    return 'No such member.';
  }

  clan.master = targetId;
  u.clanRank = RANK.MEMBER;
  target.clanRank = RANK.MASTER;
  persist(db, 'UPDATE clan SET master = ? WHERE id = ?', [targetId, clan.id]);
  persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ?', [RANK.MEMBER, u.id]);
  persist(db, 'UPDATE user_details SET clanrank = ? WHERE id = ? AND clanid = ?', [RANK.MASTER, targetId, clan.id]);

  const names = await resolveDisplaynames([targetId]);
  chat().sendClanNotice(clan.id, `${u.displayname} passed master to ${names.get(targetId) || '??'} :/`);
}

async function handlePromote(socket, db, payload) {
  if (!(await promote(db, socket.user, Number(payload[0])))) sendReply(socket, SUB.PROMOTE, [1]);
}

// Website: the master picks a gallery emblem ('g<n>') or uploads one ('u' + image bytes, checked by emblems.js).
function setEmblem(db, u, emblem, data = null) {
  const clan = clans.get(u.clanId);
  if (!clan || u.clanRank !== RANK.MASTER) return 'Only the master can change the emblem.';
  clan.emblem = emblem;
  clan.emblemData = data;
  persist(db, 'UPDATE clan SET emblem = ?, emblem_data = ? WHERE id = ?', [emblem, data, clan.id]);
  listChanged();
}

// Clan war is self-designed (no captured client flow starts one): START_WAR (1000) is outside the real 0-17 subtypes.
// No accept step: the room exists at once. require('./rooms') stays lazy: rooms.js requires this file.
// Shared with the website. The declaring player must be online in a lobby: the room is theirs (they become its master).
function declareWar(u, opponentId) {
  const clan = clans.get(u.clanId);
  if (!clan || (u.clanRank !== RANK.MASTER && u.clanRank !== RANK.OFFICER)) return { error: 'Only the master or an officer can declare war.' };
  const opponent = clans.get(opponentId);
  if (!opponent || opponentId === u.clanId) return { error: 'Choose another clan.' };
  if (!u.socket || u.channel === null || u.roomId !== null) return { error: 'Be in a game lobby (not in a room) to declare war: the war room is created for you.' };

  const { createClanWarRoom } = require('./rooms');
  const room = createClanWarRoom(u, opponentId);
  chat().sendClanNotice(opponentId, `${clan.name} declared war on your clan! Join room #${room.id} (channel ${u.channel}).`);
  chat().sendClanNotice(clan.id, `War on ${opponent.name}: room #${room.id} is ready, join it.`);
  return { room };
}

function handleStartWar(socket, db, payload) {
  const { room } = declareWar(socket.user, Number(payload[0]));
  sendReply(socket, SUB.START_WAR, room ? [1, room.id] : [0]);
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

module.exports = {
  CLAN_SYSTEM,
  CLAN_RANKING,
  SUB,
  RANK,
  MAX_MEMBERS,
  CREATE_COST,
  clanExp,
  recordWar,
  declareWar,
  setEmblem,
  clans,
  memberOf,
  resolveDisplaynames,
  createClan,
  applyClan,
  leaveClan,
  disbandBy,
  joinAction,
  rankAction,
  promote,
  loadClans,
  clanInfo,
  handleClanSystem,
  handleClanRanking,
  setAuthDb,
};
