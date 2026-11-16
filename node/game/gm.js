// GM commands, from chat.js: a "/" message from an account with user_details.is_gm=1 (loaded from the DB at
// authorization; the client's own AccessLevel field is never trusted).
const { users, getChannel } = require('./state');
const { xpForLevel, levelForXp } = require('./progression');
const { handleRoomSpectate, removeFromRoom, notifyLobbyAfterLeave, setMaster, ROOM_LEAVE, ROOM_KICK } = require('./rooms');
const { endRound } = require('./roundtimer');
const { getMap } = require('./maps');
const { grantItem } = require('./shop');

// Bans and renames live in the login DB (masterserver): game-server.js hands this module that pool once at boot.
let authDb = null;
function setAuthDb(pool) {
  authDb = pool;
}

const CHAT = 0x7400;
// Replies are whispers to the GM themself: the only type that renders as a plain chat line (docs/protocol/economy.md).
const WHISPER = 6;

// Longer replies go out as several lines: the client's input box takes 55 chars and a long packet renders as "1".
const MAX_CHAT_LINE = 50;

// Greedy word-wrap for free text. Lists use packItems, which never splits an item across lines.
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

// Packs whole items (commands, maps) into lines up to max chars, joined by sep.
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

// Every line needs its own "GM>> ": a line without the ">>" marker renders only its last bracketed token.
function replyLines(socket, lines) {
  const u = socket.user;
  lines.forEach((line) => {
    socket.sendPacket(CHAT, [1, 0, 'GM', WHISPER, u.sessionId, u.displayname, `GM>> ${line}`]);
  });
}

function reply(socket, text) {
  replyLines(socket, wrapLines(text, MAX_CHAT_LINE));
}

// The client shows level/money only from the login data, so a changed online player is warned and disconnected.
const RECONNECT_DELAY_MS = 5000;
function scheduleReconnect(targetUser, callerSocket) {
  const seconds = RECONNECT_DELAY_MS / 1000;
  const msg =
    targetUser.socket === callerSocket
      ? `Reconnect in ${seconds}s to see the changes.`
      : `A GM updated your account. Reconnecting in ${seconds}s...`;
  reply(targetUser.socket, msg);
  setTimeout(() => targetUser.socket.end(), RECONNECT_DELAY_MS);
}

// Online display name first (case-insensitive), else a raw account id: works for offline players too.
function resolveTarget(arg) {
  const needle = String(arg || '').toLowerCase();
  const byName = [...users.values()].find((u) => u.displayname.toLowerCase() === needle);
  if (byName) return { online: byName, id: byName.id };

  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) return null;
  // An online player targeted by id must take the online path, or their in-memory xp/money would overwrite this.
  const byId = [...users.values()].find((u) => u.id === id);
  return { online: byId || null, id };
}

async function cmdSetLevel(socket, db, args) {
  const target = resolveTarget(args[0]);
  const level = Math.floor(Number(args[1]));
  if (!target || !(level >= 1 && level <= 100)) {
    return reply(socket, 'Usage: /setlevel <player|id> <level 1-100>');
  }

  const xp = xpForLevel(level);
  if (target.online) target.online.xp = xp;

  const [result] = await db.query('UPDATE user_details SET xp = ? WHERE id = ?', [xp, target.id]);
  if (result.affectedRows === 0) return reply(socket, `No account with id ${target.id}.`);
  reply(socket, `Level of ${target.online ? target.online.displayname : target.id} set to ${level} (xp=${xp}).`);
  if (target.online) scheduleReconnect(target.online, socket);
}

async function cmdAddMoney(socket, db, args) {
  const target = resolveTarget(args[0]);
  const amount = Math.trunc(Number(args[1]));
  if (!target || !Number.isFinite(amount)) {
    return reply(socket, 'Usage: /addmoney <player|id> <amount>');
  }

  if (target.online) {
    target.online.money = Math.max(0, target.online.money + amount);
    // Snapshot before the await: if another command mutates target.online.money
    // while this one is waiting on the DB, re-reading it in the reply below
    // would report that other command's result instead of this one's.
    const newMoney = target.online.money;
    await db.query('UPDATE user_details SET money = GREATEST(0, CAST(money AS SIGNED) + ?) WHERE id = ?', [amount, target.id]);
    reply(socket, `Money of ${target.online.displayname} now: ${newMoney}.`);
    return scheduleReconnect(target.online, socket);
  }

  // CAST to SIGNED first: `money` is unsigned, so `money + <large negative>`
  // underflows and MariaDB throws (ER_DATA_OUT_OF_RANGE) before GREATEST(0, ...)
  // ever gets a chance to clamp it.
  const [result] = await db.query(
    'UPDATE user_details SET money = GREATEST(0, CAST(money AS SIGNED) + ?) WHERE id = ?',
    [amount, target.id]
  );
  if (result.affectedRows === 0) return reply(socket, `No account with id ${target.id}.`);
  reply(socket, `Money updated for account ${target.id}.`);
}

// days=0 grants the tier with no practical expiry (100 years out) instead
// of a real "never" - keeps checkPremiumExpiry()'s ">" comparison simple,
// no special-casing a null/forever expiry date anywhere else.
async function cmdSetPremium(socket, db, args) {
  const target = resolveTarget(args[0]);
  const tier = Math.floor(Number(args[1]));
  const days = Number(args[2]);
  if (!target || !(tier >= 0 && tier <= 4) || !Number.isFinite(days) || days < 0) {
    return reply(socket, 'Usage: /setpremium <player|id> <tier 0-4> <days>');
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
  if (result.affectedRows === 0) return reply(socket, `No account with id ${target.id}.`);

  // No reconnect: premium effects read u.premium live; only the 5th slot waits for the next login.
  const label = target.online ? target.online.displayname : target.id;
  reply(socket, `Premium of ${label} set to tier ${tier} for ${days > 0 ? `${days} days` : 'no expiry'}.`);
}

// Server-wide notice: a popup in the lobby, a yellow line inside rooms (chat.js sendNotice).
function cmdNotice(socket, db, args) {
  const text = args.join(' ');
  if (!text) return reply(socket, 'Usage: /notice <message>');
  require('./chat').sendNotice(text); // lazy: chat.js requires this module
}

// ToXiiC-Core's "kick": a full disconnect; the socket 'close' handler does the usual cleanup.
function cmdKick(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target?.online) return reply(socket, 'Usage: /kick <online player>');
  reply(target.online.socket, 'You were disconnected by a GM.');
  target.online.socket.end();
  reply(socket, `${target.online.displayname} disconnected.`);
}

// ToXiiC-Core's "kickr" (named /kickroom to be self-explanatory): sends the kick only and lets the target's own
// RoomLeave remove them, as the host kick does; removing them here races that leave and crashed the client.
function cmdKickRoom(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target?.online || target.online.roomId === null) {
    return reply(socket, 'Usage: /kickroom <player in a room>');
  }
  const room = getChannel(target.online.channel).rooms.get(target.online.roomId);
  const player = room?.players.get(target.online.sessionId);
  if (!player) return reply(socket, 'Room not found.');

  target.online.socket.sendPacket(ROOM_KICK, [1, player.slot]);
  reply(socket, `${target.online.displayname} removed from the room.`);
}

async function cmdMute(socket, db, args) {
  const target = resolveTarget(args[0]);
  const minutes = Math.floor(Number(args[1]));
  if (!target || !(minutes > 0)) return reply(socket, 'Usage: /mute <player|id> <minutes>');

  const expire = Math.floor(Date.now() / 1000) + minutes * 60;
  if (target.online) target.online.mutedexpire = expire;
  await db.query('UPDATE user_details SET mutedexpire = ? WHERE id = ?', [expire, target.id]);
  reply(socket, `${target.online ? target.online.displayname : target.id} muted for ${minutes} minutes.`);
}

async function cmdUnmute(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target) return reply(socket, 'Usage: /unmute <player|id>');

  if (target.online) target.online.mutedexpire = 0;
  await db.query('UPDATE user_details SET mutedexpire = 0 WHERE id = ?', [target.id]);
  reply(socket, `${target.online ? target.online.displayname : target.id} is no longer muted.`);
}

// Permanent ban = users.status 0, the column auth/handlers.js checks at login (as in Chapter-1-Server).
async function cmdBan(socket, db, args) {
  if (!authDb) return reply(socket, 'Ban unavailable: auth DB not connected.');
  const target = resolveTarget(args[0]);
  const reason = args.slice(1).join(' ');
  if (!target) return reply(socket, 'Usage: /ban <player|id> [reason]');

  const [result] = await authDb.query('UPDATE users SET status = 0, ban_until = 0 WHERE id = ?', [target.id]);
  if (result.affectedRows === 0) return reply(socket, `No account with id ${target.id}.`);
  if (target.online) {
    reply(target.online.socket, `You have been banned.${reason ? ` Reason: ${reason}` : ''}`);
    target.online.socket.end();
  }
  reply(socket, `Account ${target.online ? target.online.displayname : target.id} banned.${reason ? ` (${reason})` : ''}`);
}

async function cmdUnban(socket, db, args) {
  if (!authDb) return reply(socket, 'Unban unavailable: auth DB not connected.');
  const target = resolveTarget(args[0]);
  if (!target) return reply(socket, 'Usage: /unban <player|id>');

  const [result] = await authDb.query('UPDATE users SET status = 1, ban_until = 0 WHERE id = ?', [target.id]);
  if (result.affectedRows === 0) return reply(socket, `No account with id ${target.id}.`);
  reply(socket, `Account ${target.id} unbanned.`);
}

// Temporary ban: the same status=0 as /ban plus users.ban_until (sql/11); auth/handlers.js lifts it at the first login
// after that time.
async function cmdTempBan(socket, db, args) {
  if (!authDb) return reply(socket, 'Ban unavailable: auth DB not connected.');
  const target = resolveTarget(args[0]);
  const hours = Number(args[1]);
  const reason = args.slice(2).join(' ');
  if (!target || !(hours > 0)) return reply(socket, 'Usage: /tempban <player|id> <hours> [reason]');

  const until = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const [result] = await authDb.query('UPDATE users SET status = 0, ban_until = ? WHERE id = ?', [until, target.id]);
  if (result.affectedRows === 0) return reply(socket, `No account with id ${target.id}.`);
  if (target.online) {
    reply(target.online.socket, `You have been banned for ${hours} hours.${reason ? ` Reason: ${reason}` : ''}`);
    target.online.socket.end();
  }
  reply(socket, `Account ${target.online ? target.online.displayname : target.id} banned for ${hours} hours.${reason ? ` (${reason})` : ''}`);
}

// Recent anticheat strikes of an online player (anticheat.js keeps the last 10 per session).
function cmdStrikes(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target?.online) return reply(socket, 'Usage: /strikes <online player>');
  const history = target.online.ac?.history || [];
  if (!history.length) return reply(socket, `${target.online.displayname}: no strikes this session.`);
  const now = Date.now();
  replyLines(socket, [
    `${target.online.displayname}: ${history.length} strikes`,
    ...history.map((h) => `${Math.round((now - h.t) / 60000)}min ago ${h.kind}: ${h.detail}`.slice(0, MAX_CHAT_LINE)),
  ]);
}

// /giveitem, /giveroom: the same grant as a shop purchase (shop.js grantItem).
async function cmdGiveItem(socket, db, args) {
  const target = resolveTarget(args[0]);
  const code = (args[1] || '').toUpperCase();
  const days = Math.floor(Number(args[2]));
  if (!target?.online || !code || !(days > 0)) {
    return reply(socket, 'Usage: /giveitem <online player> <code> <days>');
  }
  await grantItem(db, target.online, code, days);
  reply(socket, `${code} given to ${target.online.displayname} for ${days} days.`);
  scheduleReconnect(target.online, socket);
}

async function cmdGiveRoom(socket, db, args) {
  const u = socket.user;
  const code = (args[0] || '').toUpperCase();
  const days = Math.floor(Number(args[1]));
  if (u.roomId === null) return reply(socket, 'You must be in a room.');
  if (!code || !(days > 0)) return reply(socket, 'Usage: /giveroom <code> <days>');

  const room = getChannel(u.channel).rooms.get(u.roomId);
  const targets = [...room.players.keys()].map((sid) => users.get(sid)).filter(Boolean);
  for (const t of targets) await grantItem(db, t, code, days);
  reply(socket, `${code} given to the whole room (${targets.length} players) for ${days} days.`);
  for (const t of targets) scheduleReconnect(t, socket);
}

function cmdUserInfo(socket, db, args) {
  const target = resolveTarget(args[0]);
  if (!target) return reply(socket, 'Usage: /userinfo <player|id>');

  if (!target.online) {
    return db.query('SELECT xp, money, premium, clanid, is_gm, mutedexpire FROM user_details WHERE id = ?', [target.id]).then(([rows]) => {
      if (!rows[0]) return reply(socket, `No account with id ${target.id}.`);
      const r = rows[0];
      reply(socket, `#${target.id} [offline] lvl=${levelForXp(r.xp)} xp=${r.xp} money=${r.money} premium=${r.premium} clan=${r.clanid} gm=${r.is_gm}`);
    });
  }

  const t = target.online;
  const room = t.roomId !== null ? `room ${t.roomId} (channel ${t.channel})` : `lobby (channel ${t.channel})`;
  const mute = t.mutedexpire > Date.now() / 1000 ? `muted ${Math.ceil((t.mutedexpire - Date.now() / 1000) / 60)}min` : 'not muted';
  reply(
    socket,
    `${t.displayname} #${t.id} lvl=${levelForXp(t.xp)} xp=${t.xp} money=${t.money} premium=${t.premium} clan=${t.clanId} gm=${t.isGm} ${room} ${mute}`
  );
}

// The client 22 room list shows no spectate control we could trigger, so this sends the same 0x7330 request by hand.
function cmdSpectate(socket, db, args) {
  if (socket.user.roomId !== null) return reply(socket, 'Leave your room first.');
  handleRoomSpectate(socket, { blocks: [1, args[0]] });
}

function cmdRoomInfo(socket, db, args) {
  const u = socket.user;
  const roomId = Number(args[0]);
  const room = getChannel(u.channel).rooms.get(roomId);
  if (!room) return reply(socket, `No room with id ${roomId} in channel ${u.channel}.`);

  reply(
    socket,
    `#${room.id} "${room.name}" state=${room.state === 2 ? 'Playing' : 'Waiting'} mode=${room.mode} map=${room.map} (${getMap(room.map)?.name || '?'}) ` +
      `master(slot)=${room.master} players=${room.players.size}/${room.maxPlayers} password=${room.hasPassword ? 'yes' : 'no'} ` +
      `lock=${room.userLimit ? 'yes' : 'no'} autostart=${room.autoStart ? 'yes' : 'no'}`
  );
}

// ToXiiC-Core's "rdis" (named /closeroom): the normal leave path for each player (master handover, timers), then
// each one's own ROOM_LEAVE reply, which removeFromRoom does not send, and one lobby update.
async function cmdForceCloseRoom(socket, db, args) {
  const u = socket.user;
  const roomId = Number(args[0]);
  const chan = getChannel(u.channel);
  const room = chan.rooms.get(roomId);
  if (!room) return reply(socket, `No room with id ${roomId}.`);

  const memberIds = [...room.players.keys()];
  for (const sid of memberIds) {
    const member = users.get(sid);
    if (!member) continue;
    const oldSlot = room.players.get(sid)?.slot ?? 0;
    const stillOpen = removeFromRoom(db, member);
    member.socket.sendPacket(ROOM_LEAVE, [1, sid, oldSlot, stillOpen ? stillOpen.players.size : 0, stillOpen ? stillOpen.master : 0, member.xp, member.money]);
  }
  notifyLobbyAfterLeave(room);
  reply(socket, `Room ${roomId} closed (${memberIds.length} players sent to the lobby).`);
}

// Ported from ToXiiC-Core's "endgame" - forces the current match to end,
// same payout/reset path a real win condition takes (roundtimer.js).
// The client only starts a match when IT sends Start (a server-pushed START_REPLY is ignored: live, here and in the
// autostart attempts, gamesubs.js), so /start unlocks instead: the GM becomes master and the room's next Start skips the
// ready/team-balance checks (gamesubs.js handleStart). The GM then presses Start in the client.
function cmdStart(socket) {
  const u = socket.user;
  const room = u.roomId === null ? null : getChannel(u.channel).rooms.get(u.roomId);
  if (!room || room.state !== 1) return reply(socket, 'You must be in a waiting room.');
  const me = room.players.get(u.sessionId);
  if (room.master !== me?.slot && !setMaster(room, me)) return reply(socket, 'Room full: cannot make you master.');
  room.forceStart = true;
  reply(socket, 'Start unlocked: press Start (no ready/team checks).');
}

// The GM becomes master of the room they are in, or makes another player in a room its master (rooms.js setMaster).
function cmdTakeMaster(socket) {
  const u = socket.user;
  const room = u.roomId === null ? null : getChannel(u.channel).rooms.get(u.roomId);
  if (!room) return reply(socket, 'You must be in a room.');
  if (!setMaster(room, room.players.get(u.sessionId))) return reply(socket, 'Room full: no free slot to announce it.');
  reply(socket, 'You are now the room master.');
}

function cmdSetMaster(socket, db, args) {
  const target = resolveTarget(args[0]);
  const t = target?.online;
  const room = t && t.roomId !== null ? getChannel(t.channel).rooms.get(t.roomId) : null;
  if (!room) return reply(socket, 'Usage: /setmaster <player in a room>');
  if (!setMaster(room, room.players.get(t.sessionId))) return reply(socket, 'Room full: no free slot to announce it.');
  reply(socket, `${t.displayname} is now the master of room ${room.id}.`);
}

function cmdEndGame(socket, db, args) {
  const u = socket.user;
  if (u.roomId === null) return reply(socket, 'You must be in a room.');
  const room = getChannel(u.channel).rooms.get(u.roomId);
  if (room.state !== 2) return reply(socket, 'No match running in this room.');
  endRound(room, db);
  reply(socket, 'Match ended.');
}

// ToXiiC-Core's "extendtime": adds minutes to room.downTick. Explosive rooms time their rounds themselves, so the
// reply says so instead of doing nothing silently.
function cmdExtendTime(socket, db, args) {
  const u = socket.user;
  const minutes = Number(args[0]);
  if (u.roomId === null) return reply(socket, 'You must be in a room.');
  if (!(minutes > 0)) return reply(socket, 'Usage: /extendtime <minutes>');
  const room = getChannel(u.channel).rooms.get(u.roomId);
  if (room.state !== 2) return reply(socket, 'No match running in this room.');
  room.downTick += minutes * 60000;
  reply(socket, room.mode === 0 ? 'No effect in Explosive mode.' : `Timer extended by ${minutes} minutes.`);
}

// Not in the C# references: who is online now. Named /online, not /who, to be self-explanatory in /gmhelp.
function cmdWho(socket) {
  const list = [...users.values()].map((u) => `${u.displayname}(${u.roomId !== null ? `room${u.roomId}` : 'lobby'})`);
  reply(socket, list.length ? `${list.length} online: ${list.join(', ')}` : 'Nobody online.');
}

// Not in the C# references: a direct warning to the target before a mute/kick/ban.
function cmdWarn(socket, db, args) {
  const target = resolveTarget(args[0]);
  const text = args.slice(1).join(' ');
  if (!target?.online || !text) return reply(socket, 'Usage: /warn <online player> <message>');
  reply(target.online.socket, `Warning from a GM: ${text}`);
  reply(socket, `Warning sent to ${target.online.displayname}.`);
}

// /gmhelp: the client keeps "/help" for itself. One entry per command so packItems never splits a usage line.
const HELP_COMMANDS = [
  '/setlevel <player|id> <level 1-100>',
  '/addmoney <player|id> <amount>',
  '/setpremium <player|id> <tier 0-4> <days>',
  '/notice <msg>',
  '/kick <player>',
  '/kickroom <player>',
  '/mute <player> <minutes>',
  '/unmute <player>',
  '/ban <player> [reason]',
  '/unban <player>',
  '/giveitem <player> <code> <days>',
  '/giveroom <code> <days>',
  '/userinfo <player>',
  '/roominfo <id>',
  '/spectate <room id>',
  '/closeroom <id>',
  '/start (unlock, then press Start)',
  '/takemaster',
  '/setmaster <player>',
  '/endgame',
  '/extendtime <minutes>',
  '/online',
  '/warn <player> <msg>',
  '/strikes <player>',
  '/tempban <player> <hours> [reason]',
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
  if (!cmd) return reply(socket, `Unknown command: ${name || ''}. Use /gmhelp.`);

  // One guard for every command: an unexpected error (bad DB input...) must not crash the process over a chat line.
  Promise.resolve(cmd(socket, db, args)).catch((err) => {
    console.error('GM command failed:', err.message);
    reply(socket, `Command failed: ${err.message}`);
  });
}

module.exports = { handleGmCommand, setAuthDb };
