// GM command system, invoked from chat.js: a message starting with "/" from
// an account with user_details.is_gm=1 is intercepted here instead of being
// broadcast as normal chat. is_gm lives in the game DB (loaded at
// authorization time, see handlers.js/progression.js) rather than trusting
// any client-supplied field - the client's own Authorization packet carries
// an AccessLevel byte, but nothing here validates it, so it can't be used
// to grant GM powers safely.
const { users, getChannel, roomSockets } = require('./state');
const { xpForLevel, levelForXp } = require('./progression');
const { handleRoomSpectate, removeFromRoom, notifyLobbyAfterLeave, sendRoomUpdateToLobby, setMaster, ROOM_LEAVE, ROOM_KICK } = require('./rooms');
const { endRound } = require('./roundtimer');
const { getMap } = require('./maps');
const { grantItem } = require('./shop');
const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');

// Bans/unbans live on the AUTH db (masterserver.users.status, the same
// column auth/handlers.js already checks at login - status<=0 blocks entry)
// which the game process doesn't otherwise connect to. Set once at boot from
// game-server.js instead of threading a second `db` param through
// handlers.js/chat.js/handleGmCommand for the sake of two commands - same
// "module-level singleton" shape state.js's users/channels Maps already use.
let authDb = null;
function setAuthDb(pool) {
  authDb = pool;
}

const CHAT = 0x7400;
// Game/Enums/ChatType.cs - Notice1/Notice2 are what Cristina (the reference's
// virtual assistant) uses to talk to a player. An earlier WHISPER attempt
// left the target sessionId/name fields blank (0/'NULL') and never rendered;
// a real whisper-to-you packet always carries the *recipient's own*
// sessionId/displayname in those fields (see chat.js's TYPE.WHISPER target
// send), so that's the likely reason. Switched to WHISPER with those fields
// filled in - it's the only type that shows up as a normal chat line instead
// of a popup/notice.
const WHISPER = 6;

// A real client capped its own typed chat input at 55 chars (live capture:
// "ahaha...x", 55 chars after the ">>" the client itself prepends) - and a
// single 575-char /gmhelp reply rendered as just "1" instead of the actual
// text, both pointing the same way even though they're different mechanisms
// (send-side maxlength vs. whatever breaks on receive). Any reply longer
// than a real chat line has ever been observed to be must go out as several
// normal-length lines instead of one giant packet. 50 is a conservative
// margin under the one confirmed-working 55-char data point - tighten once
// a live test finds the exact receive-side boundary.
const MAX_CHAT_LINE = 50;

// Greedy word-wrap, never splits a word - matches how a player would have
// typed it across multiple lines by hand. Fine for free-form text (a single
// sentence), but for a LIST of independent items (each command in /gmhelp,
// each map in /maps) it only guarantees whole *words* survive, not whole
// *items* - a two-word map name like "Rusty Nails" or a multi-token command
// usage like "/setpremium <giocatore|id> <tier 0-4> <giorni>" can still get
// cut in half between two lines, which is exactly what made /gmhelp's output
// hard to read once it stopped being one giant unreadable packet (Fase 38)
// and became several oddly-cut ones instead. Use packItems below for lists.
function wrapLines(text, max) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Greedy-packs whole ITEMS (never splits one) into lines up to max chars,
// joined by sep - each line boundary always falls between two complete
// items, so a reader can always tell where one command/map/etc. ends and
// the next begins, unlike wrapLines' word-level wrap above.
function packItems(items, max, sep = ' | ') {
  const lines = [];
  let cur = '';
  for (const item of items) {
    const next = cur ? `${cur}${sep}${item}` : item;
    if (next.length > max && cur) {
      lines.push(cur);
      cur = item;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Tried "GM>> " only on the first line, to save characters (every other
// line bare). Live test against the real client: line 1 rendered fully, but
// every bare continuation line rendered as only its LAST bracketed token
// ("/addmoney <giocatore|id> <importo>" showed as just "<giocatore|id>") -
// not a length problem, a missing-marker one. Same lesson Fase 36 already
// found for Notice1 (no ">>" marker -> broken/empty render), just for
// WHISPER too: every line apparently needs its own ">>" to render its text
// at all, not just the first. Costs a few chars per line but that's still
// well inside the MAX_CHAT_LINE budget (measured live: "GM>> " + 41 chars of
// content rendered fine in one line).
function replyLines(socket, lines) {
  const u = socket.user;
  lines.forEach((line) => {
    socket.sendPacket(CHAT, [1, 0, 'GM', WHISPER, u.sessionId, u.displayname, `GM>> ${line}`]);
  });
}

function reply(socket, text) {
  replyLines(socket, wrapLines(text, MAX_CHAT_LINE));
}

// Level/money changes only show up in the client's own UI from data it
// received at login (Authorization packet) - there's no live-refresh packet
// for this in the reference. Closest a player can get to seeing the change
// immediately is reconnecting, so whichever online session actually got
// mutated is warned and then dropped - forcing the relogin instead of
// leaving them to notice nothing changed.
const RECONNECT_DELAY_MS = 5000;
function scheduleReconnect(targetUser, callerSocket) {
  const seconds = RECONNECT_DELAY_MS / 1000;
  const msg =
    targetUser.socket === callerSocket
      ? `Riconnettiti tra ${seconds}s per vedere le modifiche.`
      : `Un GM ha aggiornato i tuoi dati. Riconnessione tra ${seconds}s...`;
  reply(targetUser.socket, msg);
  setTimeout(() => targetUser.socket.end(), RECONNECT_DELAY_MS);
}

// By online displayname first (case-insensitive - "wruser" should find
// "WRUser", the real client's actual casing), otherwise the argument is
// treated as a raw account id - works offline too, without needing a
// cross-database lookup for a nickname (see the plan).
function resolveTarget(arg) {
  const needle = String(arg || '').toLowerCase();
  const byName = [...users.values()].find((u) => u.displayname.toLowerCase() === needle);
  if (byName) return { online: byName, id: byName.id };

  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) return null;
  // Also match by id among online users - otherwise targeting a connected
  // player by their numeric id (instead of name) would silently take the
  // "offline" DB-only path, leaving their live in-memory xp/money stale
  // until next login and overwriting this update on their next save.
  const byId = [...users.values()].find((u) => u.id === id);
  return { online: byId || null, id };
}

async function cmdSetLevel(socket, db, args) {
  const target = resolveTarget(args[0]);
  const level = Math.floor(Number(args[1]));
  if (!target || !(level >= 1 && level <= 100)) {
    return reply(socket, 'Uso: /setlevel <giocatore|id> <livello 1-100>');
  }

  const xp = xpForLevel(level);
  if (target.online) target.online.xp = xp;

  const [result] = await db.query('UPDATE user_details SET xp = ? WHERE id = ?', [xp, target.id]);
  if (result.affectedRows === 0) return reply(socket, `Nessun account con id ${target.id}.`);
  reply(socket, `Livello di ${target.online ? target.online.displayname : target.id} impostato a ${level} (xp=${xp}).`);
  if (target.online) scheduleReconnect(target.online, socket);
}

async function cmdAddMoney(socket, db, args) {
  const target = resolveTarget(args[0]);
  const amount = Math.trunc(Number(args[1]));
  if (!target || !Number.isFinite(amount)) {
    return reply(socket, 'Uso: /addmoney <giocatore|id> <importo>');
  }

  if (target.online) {
    target.online.money = Math.max(0, target.online.money + amount);
    // Snapshot before the await: if another command mutates target.online.money
    // while this one is waiting on the DB, re-reading it in the reply below
    // would report that other command's result instead of this one's.
    const newMoney = target.online.money;
    await db.query('UPDATE user_details SET money = GREATEST(0, CAST(money AS SIGNED) + ?) WHERE id = ?', [amount, target.id]);
    reply(socket, `Denaro di ${target.online.displayname} ora: ${newMoney}.`);
    return scheduleReconnect(target.online, socket);
  }

  // CAST to SIGNED first: `money` is unsigned, so `money + <large negative>`
  // underflows and MariaDB throws (ER_DATA_OUT_OF_RANGE) before GREATEST(0, ...)
  // ever gets a chance to clamp it.
  const [result] = await db.query(
    'UPDATE user_details SET money = GREATEST(0, CAST(money AS SIGNED) + ?) WHERE id = ?',
    [amount, target.id]
  );
  if (result.affectedRows === 0) return reply(socket, `Nessun account con id ${target.id}.`);
  reply(socket, `Denaro aggiornato per l'account ${target.id}.`);
}

// giorni=0 grants the tier with no practical expiry (100 years out) instead
// of a real "never" - keeps checkPremiumExpiry()'s ">" comparison simple,
// no special-casing a null/forever expiry date anywhere else.
async function cmdSetPremium(socket, db, args) {
  const target = resolveTarget(args[0]);
  const tier = Math.floor(Number(args[1]));
  const days = Number(args[2]);
  if (!target || !(tier >= 0 && tier <= 4) || !Number.isFinite(days) || days < 0) {
    return reply(socket, 'Uso: /setpremium <giocatore|id> <tier 0-4> <giorni>');
  }

  const expireDate = Math.floor(Date.now() / 1000) + Math.round((days > 0 ? days : 36500) * 86400);
  if (target.online) {
    target.online.premium = tier;
    target.online.premiumExpireDate = expireDate;
  }

  const [result] = await db.query('UPDATE user_details SET premium = ?, premium_expiredate = ? WHERE id = ?', [
    tier,
    expireDate,
    target.id,
  ]);
  if (result.affectedRows === 0) return reply(socket, `Nessun account con id ${target.id}.`);

  // No scheduleReconnect here unlike setlevel/addmoney: premium's live
  // effects (room-roster badge, XP bonus math) already read u.premium
  // directly, no stale-until-relogin field involved - only the 5th-slot
  // SlotState needs a fresh Authorization packet to show it, the same minor
  // known gap as level/money, not worth a forced kick. Consistent with
  // expiry itself being notify-only (see checkPremiumExpiry/ping.js).
  const label = target.online ? target.online.displayname : target.id;
  reply(socket, `Premium di ${label} impostato a tier ${tier} per ${days > 0 ? `${days} giorni` : 'senza scadenza pratica'}.`);
}

// Server-wide notice: a popup in the lobby, a yellow line inside rooms (chat.js sendNotice).
function cmdNotice(socket, db, args) {
  const text = args.join(' ');
  if (!text) return reply(socket, 'Uso: /notice <messaggio>');
  require('./chat').sendNotice(text); // lazy: chat.js requires this module
}

// Ported from ToXiiC-Core's "kick" - a full disconnect. Cleanup (room
// removal, lobby notification, users Map deletion) already happens in the
// socket 'close' handler (handlers.js), same as any other disconnect - no
// special-casing needed here.
function cmdKick(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target?.online) return reply(socket, 'Uso: /kick <giocatore online>');
  reply(target.online.socket, 'Sei stato disconnesso da un GM.');
  target.online.socket.end();
  reply(socket, `${target.online.displayname} disconnesso.`);
}

// Ported from ToXiiC-Core's "kickr" - removes the target from their current
// room only, not a full disconnect. Exposed as /kickroom, not /kickr: the
// user found the original abbreviation unclear next to plain /kick without
// a description, and a chat command list has no room for descriptions
// without blowing past the per-line budget Fase 38 just fixed - a
// self-explanatory name is the cheaper fix. Reuses the exact wire behavior
// already fixed for the host-kick crash bug (Fase precedente): notify only,
// let the target's own follow-up RoomLeave do the real removal - calling
// removeFromRoom directly here would race ahead of it the same way that bug
// did.
function cmdKickRoom(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target?.online || target.online.roomId === null) {
    return reply(socket, 'Uso: /kickroom <giocatore in una stanza>');
  }
  const room = getChannel(target.online.channel).rooms.get(target.online.roomId);
  const player = room?.players.get(target.online.sessionId);
  if (!player) return reply(socket, 'Stanza non trovata.');

  target.online.socket.sendPacket(ROOM_KICK, [1, player.slot]);
  reply(socket, `${target.online.displayname} rimosso dalla stanza.`);
}

async function cmdMute(socket, db, args) {
  const target = resolveTarget(args[0]);
  const minutes = Math.floor(Number(args[1]));
  if (!target || !(minutes > 0)) return reply(socket, 'Uso: /mute <giocatore|id> <minuti>');

  const expire = Math.floor(Date.now() / 1000) + minutes * 60;
  if (target.online) target.online.mutedexpire = expire;
  await db.query('UPDATE user_details SET mutedexpire = ? WHERE id = ?', [expire, target.id]);
  reply(socket, `${target.online ? target.online.displayname : target.id} silenziato per ${minutes} minuti.`);
}

async function cmdUnmute(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target) return reply(socket, 'Uso: /unmute <giocatore|id>');

  if (target.online) target.online.mutedexpire = 0;
  await db.query('UPDATE user_details SET mutedexpire = 0 WHERE id = ?', [target.id]);
  reply(socket, `${target.online ? target.online.displayname : target.id} non è più silenziato.`);
}

// Ban/unban reuse the SAME column auth/handlers.js already checks at login
// (users.status<=0 -> ERROR_CODES.banned) - the exact pattern Chapter-1-Server
// uses too (status doubles as ban flag). Permanent only, no expiry timer
// (ToXiiC-Core's /ban has one; skipped here, add if a temp ban is ever
// actually needed). Lives on the AUTH db, not the game db `db` param - see
// setAuthDb at the top of this file for why.
async function cmdBan(socket, db, args) {
  if (!authDb) return reply(socket, 'Ban non disponibile: auth DB non collegato.');
  const target = resolveTarget(args[0]);
  const reason = args.slice(1).join(' ');
  if (!target) return reply(socket, 'Uso: /ban <giocatore|id> [motivo]');

  const [result] = await authDb.query('UPDATE users SET status = 0, ban_until = 0 WHERE id = ?', [target.id]);
  if (result.affectedRows === 0) return reply(socket, `Nessun account con id ${target.id}.`);
  if (target.online) {
    reply(target.online.socket, `Sei stato bannato.${reason ? ` Motivo: ${reason}` : ''}`);
    target.online.socket.end();
  }
  reply(socket, `Account ${target.online ? target.online.displayname : target.id} bannato.${reason ? ` (${reason})` : ''}`);
}

async function cmdUnban(socket, db, args) {
  if (!authDb) return reply(socket, 'Unban non disponibile: auth DB non collegato.');
  const target = resolveTarget(args[0]);
  if (!target) return reply(socket, 'Uso: /unban <giocatore|id>');

  const [result] = await authDb.query('UPDATE users SET status = 1, ban_until = 0 WHERE id = ?', [target.id]);
  if (result.affectedRows === 0) return reply(socket, `Nessun account con id ${target.id}.`);
  reply(socket, `Account ${target.id} sbannato.`);
}

// Temporary ban: the same status=0 as /ban plus users.ban_until (sql/11); auth/handlers.js lifts it at the first login
// after that time.
async function cmdTempBan(socket, db, args) {
  if (!authDb) return reply(socket, 'Ban non disponibile: auth DB non collegato.');
  const target = resolveTarget(args[0]);
  const hours = Number(args[1]);
  const reason = args.slice(2).join(' ');
  if (!target || !(hours > 0)) return reply(socket, 'Uso: /tempban <giocatore|id> <ore> [motivo]');

  const until = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const [result] = await authDb.query('UPDATE users SET status = 0, ban_until = ? WHERE id = ?', [until, target.id]);
  if (result.affectedRows === 0) return reply(socket, `Nessun account con id ${target.id}.`);
  if (target.online) {
    reply(target.online.socket, `Sei stato bannato per ${hours} ore.${reason ? ` Motivo: ${reason}` : ''}`);
    target.online.socket.end();
  }
  reply(socket, `Account ${target.online ? target.online.displayname : target.id} bannato per ${hours} ore.${reason ? ` (${reason})` : ''}`);
}

// Recent anticheat strikes of an online player (anticheat.js keeps the last 10 per session).
function cmdStrikes(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target?.online) return reply(socket, 'Uso: /strikes <giocatore online>');
  const history = target.online.ac?.history || [];
  if (!history.length) return reply(socket, `${target.online.displayname}: nessuna violazione in questa sessione.`);
  const now = Date.now();
  replyLines(socket, [
    `${target.online.displayname}: ${history.length} violazioni`,
    ...history.map((h) => `${Math.round((now - h.t) / 60000)}min fa ${h.kind}: ${h.detail}`.slice(0, MAX_CHAT_LINE)),
  ]);
}

// /giveitem, /giveroom: reuse shop.js's own grantItem(db, u, code, days) -
// the exact same INSERT a real item-shop purchase makes, so the target's
// next Authorization packet already reflects it, no bespoke insert here.
async function cmdGiveItem(socket, db, args) {
  const target = resolveTarget(args[0]);
  const code = (args[1] || '').toUpperCase();
  const days = Math.floor(Number(args[2]));
  if (!target?.online || !code || !(days > 0)) {
    return reply(socket, 'Uso: /giveitem <giocatore online> <codice> <giorni>');
  }
  await grantItem(db, target.online, code, days);
  reply(socket, `${code} regalato a ${target.online.displayname} per ${days} giorni.`);
  scheduleReconnect(target.online, socket);
}

async function cmdGiveRoom(socket, db, args) {
  const u = socket.user;
  const code = (args[0] || '').toUpperCase();
  const days = Math.floor(Number(args[1]));
  if (u.roomId === null) return reply(socket, 'Devi essere in una stanza.');
  if (!code || !(days > 0)) return reply(socket, 'Uso: /giveroom <codice> <giorni>');

  const room = getChannel(u.channel).rooms.get(u.roomId);
  const targets = [...room.players.keys()].map((sid) => users.get(sid)).filter(Boolean);
  for (const t of targets) await grantItem(db, t, code, days);
  reply(socket, `${code} regalato a tutta la stanza (${targets.length} giocatori) per ${days} giorni.`);
  for (const t of targets) scheduleReconnect(t, socket);
}

function cmdUserInfo(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target) return reply(socket, 'Uso: /userinfo <giocatore|id>');

  if (!target.online) {
    return db.query('SELECT xp, money, premium, clanid, is_gm, mutedexpire FROM user_details WHERE id = ?', [target.id]).then(([rows]) => {
      if (!rows[0]) return reply(socket, `Nessun account con id ${target.id}.`);
      const r = rows[0];
      reply(socket, `#${target.id} [offline] lvl=${levelForXp(r.xp)} xp=${r.xp} money=${r.money} premium=${r.premium} clan=${r.clanid} gm=${r.is_gm}`);
    });
  }

  const t = target.online;
  const room = t.roomId !== null ? `stanza ${t.roomId} (canale ${t.channel})` : `lobby (canale ${t.channel})`;
  const mute = t.mutedexpire > Date.now() / 1000 ? `silenziato ${Math.ceil((t.mutedexpire - Date.now() / 1000) / 60)}min` : 'non silenziato';
  reply(
    socket,
    `${t.displayname} #${t.id} lvl=${levelForXp(t.xp)} xp=${t.xp} money=${t.money} premium=${t.premium} clan=${t.clanId} gm=${t.isGm} ${room} ${mute}`
  );
}

// The client 22 room list shows no spectate control we could trigger, so this sends the same 0x7330 request by hand.
function cmdSpectate(socket, db, args) {
  if (socket.user.roomId !== null) return reply(socket, 'Esci prima dalla stanza.');
  handleRoomSpectate(socket, { blocks: [1, args[0]] });
}

function cmdRoomInfo(socket, db, args) {
  const u = socket.user;
  const roomId = Number(args[0]);
  const room = getChannel(u.channel).rooms.get(roomId);
  if (!room) return reply(socket, `Nessuna stanza con id ${roomId} nel canale ${u.channel}.`);

  reply(
    socket,
    `#${room.id} "${room.name}" stato=${room.state === 2 ? 'Playing' : 'Waiting'} modo=${room.mode} mappa=${room.map} (${getMap(room.map)?.name || '?'}) ` +
      `master(slot)=${room.master} giocatori=${room.players.size}/${room.maxPlayers} password=${room.hasPassword ? 'si' : 'no'} ` +
      `lock=${room.userLimit ? 'si' : 'no'} autostart=${room.autoStart ? 'si' : 'no'}`
  );
}

// Ported from ToXiiC-Core's "rdis" - force-closes a room, everyone back to
// lobby. Exposed as /closeroom, not /rdis - same discoverability reason as
// /kickroom above, "rdis" gives no hint at all of what it does.
// Reuses removeFromRoom per player (same function the real RoomLeave
// handler calls) so master reassignment/round-timer teardown/roster
// broadcasts all happen exactly like a normal mass-leave, then sends each
// removed player their own ROOM_LEAVE reply (removeFromRoom itself only
// notifies the *other* room members, same split rooms.js's own
// handleRoomLeave already relies on) and a single lobby update at the end.
async function cmdForceCloseRoom(socket, db, args) {
  const u = socket.user;
  const roomId = Number(args[0]);
  const chan = getChannel(u.channel);
  const room = chan.rooms.get(roomId);
  if (!room) return reply(socket, `Nessuna stanza con id ${roomId}.`);

  const memberIds = [...room.players.keys()];
  for (const sid of memberIds) {
    const member = users.get(sid);
    if (!member) continue;
    const oldSlot = room.players.get(sid)?.slot ?? 0;
    const stillOpen = removeFromRoom(db, member);
    member.socket.sendPacket(ROOM_LEAVE, [1, sid, oldSlot, stillOpen ? stillOpen.players.size : 0, stillOpen ? stillOpen.master : 0, member.xp, member.money]);
  }
  notifyLobbyAfterLeave(room);
  reply(socket, `Stanza ${roomId} chiusa forzatamente (${memberIds.length} giocatori rimandati in lobby).`);
}

// Ported from ToXiiC-Core's "endgame" - forces the current match to end,
// same payout/reset path a real win condition takes (roundtimer.js).
// Starts the match of the GM's own room as if its master had pressed Start (same checks: everyone ready, 2+ players,
// balanced teams); "/start force" skips them. Lazy require: gamesubs.js loads rooms.js, which this module also needs.
function cmdStart(socket, db, args) {
  const { HANDLERS, SUB, GAME_PACKET, beginMatch } = require('./gamesubs');
  const u = socket.user;
  const room = u.roomId === null ? null : getChannel(u.channel).rooms.get(u.roomId);
  if (!room || room.state !== 1) return reply(socket, 'Devi essere in una stanza in attesa.');
  const master = [...room.players.values()].find((p) => p.slot === room.master);
  if (!master) return reply(socket, 'La stanza non ha un master.');
  let r;
  if ((args[0] || '').toLowerCase() === 'force') {
    beginMatch(room, db);
    r = { newType: SUB.START_REPLY, payload: [0, 0, room.map] }; // what the Start handler replies
  } else {
    r = HANDLERS[SUB.START](room, master, [0, 0, 0], u, db);
    if (!r) return reply(socket, 'Non tutti pronti o squadre sbilanciate. /start force per avviare comunque.');
  }
  broadcastPacket(roomSockets(room), XOR.external, GAME_PACKET, [1, master.slot, room.id, 2, r.newType, ...r.payload]);
  sendRoomUpdateToLobby(room, true);
}

// The GM becomes master of the room they are in, or makes another player in a room its master (rooms.js setMaster).
function cmdTakeMaster(socket) {
  const u = socket.user;
  const room = u.roomId === null ? null : getChannel(u.channel).rooms.get(u.roomId);
  if (!room) return reply(socket, 'Devi essere in una stanza.');
  if (!setMaster(room, room.players.get(u.sessionId))) return reply(socket, 'Stanza piena: nessuno slot libero per annunciarlo.');
  reply(socket, 'Ora sei il master della stanza.');
}

function cmdSetMaster(socket, db, args) {
  const target = resolveTarget(args[0]);
  const t = target?.online;
  const room = t && t.roomId !== null ? getChannel(t.channel).rooms.get(t.roomId) : null;
  if (!room) return reply(socket, 'Uso: /setmaster <giocatore in una stanza>');
  if (!setMaster(room, room.players.get(t.sessionId))) return reply(socket, 'Stanza piena: nessuno slot libero per annunciarlo.');
  reply(socket, `${t.displayname} ora è il master della stanza ${room.id}.`);
}

function cmdEndGame(socket, db, args) {
  const u = socket.user;
  if (u.roomId === null) return reply(socket, 'Devi essere in una stanza.');
  const room = getChannel(u.channel).rooms.get(u.roomId);
  if (room.state !== 2) return reply(socket, 'Nessuna partita in corso in questa stanza.');
  endRound(room, db);
  reply(socket, 'Partita terminata forzatamente.');
}

// Ported from ToXiiC-Core's "extendtime" - adds minutes to the room's
// running countdown (room.downTick, roundtimer.js). No-op for Explosive
// rooms: their round timing is driven by tickExplosive's own state machine,
// not downTick (see roundtimer.js) - flagged in the reply rather than
// silently doing nothing.
function cmdExtendTime(socket, db, args) {
  const u = socket.user;
  const minutes = Number(args[0]);
  if (u.roomId === null) return reply(socket, 'Devi essere in una stanza.');
  if (!(minutes > 0)) return reply(socket, 'Uso: /extendtime <minuti>');
  const room = getChannel(u.channel).rooms.get(u.roomId);
  if (room.state !== 2) return reply(socket, 'Nessuna partita in corso in questa stanza.');
  room.downTick += minutes * 60000;
  reply(socket, room.mode === 0 ? 'Attenzione: nessun effetto in modalità Explosive.' : `Timer esteso di ${minutes} minuti.`);
}

// Non-porting addition (non presente in nessuno dei due riferimenti C#):
// elenco rapido di chi è connesso ora, utile su un server con pochi account
// di test. Esposto come /online, non /who - stessa ragione di
// /kickroom/closeroom: un nome che si spiega da solo nella lista comandi.
function cmdWho(socket) {
  const list = [...users.values()].map((u) => `${u.displayname}(${u.roomId !== null ? `stanza${u.roomId}` : 'lobby'})`);
  reply(socket, list.length ? `${list.length} online: ${list.join(', ')}` : 'Nessuno online.');
}

// Non-porting addition: un avviso diretto al target prima di silenziare/
// espellere/bannare, riusando reply() ma indirizzato al target invece che a
// chi lancia il comando.
function cmdWarn(socket, db, args) {
  const target = resolveTarget(args[0]);
  const text = args.slice(1).join(' ');
  if (!target?.online || !text) return reply(socket, 'Uso: /warn <giocatore online> <messaggio>');
  reply(target.online.socket, `Avviso da un GM: ${text}`);
  reply(socket, `Avviso inviato a ${target.online.displayname}.`);
}

// Named /gmhelp, not /help - the client itself intercepts "/help" locally
// (shows its own built-in command list, never reaches the server as chat).
// One array entry per command - packItems below only ever joins WHOLE
// entries onto a line, so a multi-token usage like "/setpremium <giocatore|id>
// <tier 0-4> <giorni>" can never be cut in half across two chat lines the
// way wrapLines' word-level wrap could (Fase 38's fix helped readability but
// didn't fully solve it - see packItems' own comment above).
const HELP_COMMANDS = [
  '/setlevel <giocatore|id> <livello 1-100>',
  '/addmoney <giocatore|id> <importo>',
  '/setpremium <giocatore|id> <tier 0-4> <giorni>',
  '/notice <msg>',
  '/kick <giocatore>',
  '/kickroom <giocatore>',
  '/mute <giocatore> <minuti>',
  '/unmute <giocatore>',
  '/ban <giocatore> [motivo]',
  '/unban <giocatore>',
  '/giveitem <giocatore> <codice> <giorni>',
  '/giveroom <codice> <giorni>',
  '/userinfo <giocatore>',
  '/roominfo <id>',
  '/spectate <id stanza>',
  '/closeroom <id>',
  '/start [force]',
  '/takemaster',
  '/setmaster <giocatore>',
  '/endgame',
  '/extendtime <minuti>',
  '/online',
  '/warn <giocatore> <msg>',
  '/strikes <giocatore>',
  '/tempban <giocatore> <ore> [motivo]',
  '/gmhelp',
];

function cmdHelp(socket) {
  replyLines(socket, packItems(HELP_COMMANDS, MAX_CHAT_LINE));
}

const COMMANDS = {
  setlevel: cmdSetLevel,
  addmoney: cmdAddMoney,
  setpremium: cmdSetPremium,
  notice: cmdNotice,
  kick: cmdKick,
  kickroom: cmdKickRoom,
  mute: cmdMute,
  unmute: cmdUnmute,
  ban: cmdBan,
  unban: cmdUnban,
  giveitem: cmdGiveItem,
  giveroom: cmdGiveRoom,
  userinfo: cmdUserInfo,
  roominfo: cmdRoomInfo,
  spectate: cmdSpectate,
  closeroom: cmdForceCloseRoom,
  start: cmdStart,
  takemaster: cmdTakeMaster,
  setmaster: cmdSetMaster,
  endgame: cmdEndGame,
  extendtime: cmdExtendTime,
  online: cmdWho,
  warn: cmdWarn,
  strikes: cmdStrikes,
  tempban: cmdTempBan,
  gmhelp: cmdHelp,
};

function handleGmCommand(socket, db, text) {
  const [name, ...args] = text.slice(1).split(' ').filter(Boolean);
  const cmd = COMMANDS[(name || '').toLowerCase()];
  if (!cmd) return reply(socket, `Comando sconosciuto: ${name || ''}. Usa /gmhelp.`);

  // Guard once here, not per-command: an unexpected error (bad DB input,
  // etc.) must never crash the whole process over one chat message - it did
  // exactly that the first time (an unsigned-arithmetic underflow in
  // cmdAddMoney) before this existed.
  Promise.resolve(cmd(socket, db, args)).catch((err) => {
    console.error('GM command failed:', err.message);
    reply(socket, `Errore eseguendo il comando: ${err.message}`);
  });
}

module.exports = { handleGmCommand, setAuthDb };
