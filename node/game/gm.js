// GM command system, invoked from chat.js: a message starting with "/" from
// an account with user_details.is_gm=1 is intercepted here instead of being
// broadcast as normal chat. is_gm lives in the game DB (loaded at
// authorization time, see handlers.js/progression.js) rather than trusting
// any client-supplied field - the client's own Authorization packet carries
// an AccessLevel byte, but nothing here validates it, so it can't be used
// to grant GM powers safely.
const { users, getChannel } = require('./state');
const { xpForLevel } = require('./progression');

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

function reply(socket, text) {
  const u = socket.user;
  socket.sendPacket(CHAT, [1, 0, 'GM', WHISPER, u.sessionId, u.displayname, `GM>> ${text}`]);
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
    await db.query('UPDATE user_details SET money = ? WHERE id = ?', [newMoney, target.id]);
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

// Investigation tool, not a ported reference command: forces fields 0-6 of
// the next auto-respawn Spawn packet (gamesubs.js's scheduleAutoRespawn) to
// whatever's given here instead of the client's own real values, so the
// TDM spawn-point mystery can be probed live - change the values, wait for
// a death+5s, look, repeat - no server restart needed between tries.
function cmdSpawnFields(socket, db, args) {
  const u = socket.user;
  const room = u.roomId !== null ? getChannel(u.channel).rooms.get(u.roomId) : null;
  if (!room) return reply(socket, 'Devi essere in una stanza.');

  if ((args[0] || '').toLowerCase() === 'off') {
    room.spawnTestFields = null;
    return reply(socket, 'Override spento - i respawn tornano a usare i valori reali del client.');
  }

  const values = args.slice(0, 7).map(Number);
  if (values.length !== 7 || values.some((n) => !Number.isFinite(n))) {
    return reply(socket, 'Uso: /spawnfields <v0> <v1> <v2> <v3> <v4> <v5> <v6> | /spawnfields off');
  }
  room.spawnTestFields = values;
  reply(socket, `Override attivo: [${values.join(', ')}] - verrà usato al prossimo auto-respawn nella stanza.`);
}

// Opt-in variety, not a real fix: rotates ONLY idx2 (the field confirmed to
// pick the point - see /spawnfields' investigation) through a GM-curated
// list, per team, leaving every other field (class etc.) as the player's
// own real value. Deliberately doesn't guess new values on its own -
// wrong ones have been observed to crash the client outright or lock it in
// a respawn loop, and which values are safe isn't stable session to
// session, so this only ever uses whatever a GM has already manually
// verified in *this* session via /spawnfields. Off by default, never
// affects a room unless explicitly turned on.
function cmdSpawnCycle(socket, db, args) {
  const u = socket.user;
  const room = u.roomId !== null ? getChannel(u.channel).rooms.get(u.roomId) : null;
  if (!room) return reply(socket, 'Devi essere in una stanza.');

  if ((args[0] || '').toLowerCase() === 'off') {
    room.spawnCycle = null;
    return reply(socket, 'Ciclo spawn disattivato.');
  }

  const team = { team0: 0, team1: 1 }[(args[0] || '').toLowerCase()];
  const values = args.slice(1).map(Number);
  if (team === undefined || values.length === 0 || values.some((n) => !Number.isFinite(n))) {
    return reply(socket, 'Uso: /spawncycle team0|team1 <valori idx2 già verificati sicuri...> | /spawncycle off');
  }
  room.spawnCycle = room.spawnCycle || {};
  room.spawnCycle[team] = { values, index: 0 };
  reply(socket, `Ciclo attivo per team${team}: [${values.join(', ')}] - un valore diverso a ogni respawn di quella squadra.`);
}

// Named /gmhelp, not /help - the client itself intercepts "/help" locally
// (shows its own built-in command list, never reaches the server as chat).
function cmdHelp(socket) {
  reply(
    socket,
    '/setlevel <giocatore|id> <livello 1-100> | /addmoney <giocatore|id> <importo> | ' +
      '/setpremium <giocatore|id> <tier 0-4> <giorni> | /spawnfields <7 valori>|off | ' +
      '/spawncycle team0|team1 <valori>|off | /gmhelp'
  );
}

const COMMANDS = {
  setlevel: cmdSetLevel,
  addmoney: cmdAddMoney,
  setpremium: cmdSetPremium,
  spawnfields: cmdSpawnFields,
  spawncycle: cmdSpawnCycle,
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

module.exports = { handleGmCommand };
