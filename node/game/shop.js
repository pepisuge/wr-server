// Ported from Game/Handlers/Itemshop.cs + Game/Packets/Itemshop.cs. Unlike
// clan.js/gm.js, this is a real port, not an invented protocol - the
// reference has a complete, working shop.
const { levelForXp } = require('./progression');
const { getItem } = require('./items');
const { ownsItem, buildItemlist, buildSlotState, MAX_ITEMS } = require('./inventory');

const ITEMSHOP = 0x7600;
const BUY_ITEM = 0x456; // Enums.ItemAction.BuyItem
// Client 22 uses items two ways (live captures): CB03 on ITEMSHOP [1111, code, ?, ?, -1], CB01 (asks a name first) on
// 0x7800 [1111, ?, ?, code, nickname] (FUN_00468810 via FUN_005484b0). Ported from ToXiiC-Core's
// CashItemBuy.cs OnItemUse: only CB01 (rename) and CB03 (kill/death reset); its other cases (CZ73 ham radio,
// random/gift boxes) need a package-reward system this schema has no tables for.
const CASH_ITEM = 0x7800;
const USE_ITEM = 0x457; // 1111

// Same pattern as gm.js/clan.js: CB01's rename touches masterserver.users
// (displayname), not this process's own `db` pool (wres2).
let authDb = null;
function setAuthDb(pool) {
  authDb = pool;
}

// Packets/Itemshop.cs's ErrorCodes enum, the values actually reachable from
// this handler's validation chain.
const ERROR = {
  PREMIUM_ONLY: 98010,
  INVALID_ITEM: 97010,
  CANNOT_BE_BOUGHT: 97020,
  NOT_ENOUGH_DINAR: 97040,
  LEVEL_REQUIREMENT: 97060,
  INVENTORY_FULL: 97070,
};

const DAYS = [3, 7, 15, 30, 3650]; // item_shop.cost is indexed by this; index 4 = "permanent" (the client sends it, e.g. DA05) = 10 years

function sendError(socket, code) {
  socket.sendPacket(ITEMSHOP, [code]);
}

// Also the reply to an item use on ITEMSHOP (action 1111): client 22's handler (FUN_005f5da0/FUN_005f5f10) then zeroes
// its own kill/death counters and shows "Item use successful.".
function sendSuccess(socket, u, action = BUY_ITEM) {
  socket.sendPacket(ITEMSHOP, [
    1,
    action,
    -1,
    3,
    u.inventory.size,
    buildItemlist(u.inventory),
    u.money,
    buildSlotState(u, u.inventory),
  ]);
}

// Adds one item to a user's inventory: memory now, and returns the INSERT's promise (q = the pool or a transaction's
// connection). No money involved: the buy flow charges separately, coupon and GM grants are free.
function grantItem(q, u, code, days) {
  const now = Math.floor(Date.now() / 1000);
  const lengthSeconds = 86400 * days;
  u.inventory.set(code, { expireDate: now + lengthSeconds, retail: false });
  return q.query(
    'INSERT INTO user_inventory (owner, code, startdate, length, price, expired, deleted) VALUES (?, ?, ?, ?, 0, 0, 0)',
    [u.id, code, now, lengthSeconds]
  );
}

// The reverse of grantItem - spends one owned item. Used below for CB01/CB03
// and by clan.js's NickChange (CB02) - real consumable items, not stackable
// quantities, so "consume" just drops the one row this schema tracks per
// owned code.
function removeItem(db, u, code) {
  u.inventory.delete(code);
  db.query('UPDATE user_inventory SET deleted = 1 WHERE owner = ? AND code = ? AND deleted = 0', [u.id, code]).catch(
    (err) => console.error('shop: failed to persist item consumption:', err.message)
  );
}

// CB01 - Managers/CashItemBuy.cs's OnItemUse "CB01" case: rename the
// account's displayname (masterserver.users), rejecting a collision the same
// way the reference does (a plain SELECT check, no DB unique constraint on
// this column either).
// The unique index on users.displayname (sql/09, case-insensitive collation) is the only check: a separate SELECT
// let two players racing for one name both pass. Memory changes only once the DB took it.
async function renameDisplayname(u, nickname) {
  if (!authDb) return false;
  try {
    await authDb.query('UPDATE users SET displayname = ? WHERE id = ?', [nickname, u.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
  u.displayname = nickname;
  return true;
}

// items.bin's `users.displayname` column is varchar(16); IsAlphaNumeric in
// the reference has no length check of its own, just the column width.
const NICKNAME_RE = /^[a-zA-Z0-9]{3,16}$/;
// Names the server signs its own lines with (SYSTEM>> whispers, Notice>>, ClanSystem>>) or that pass for staff:
// a player called "System" could whisper fake system messages.
const RESERVED_RE = /^(gm|system|notice|clansystem|admin)/i;
const validNickname = (name) => NICKNAME_RE.test(name) && !RESERVED_RE.test(name);

// Replies are ToXiiC's SP_CashItemUse: [1111, 1, code, itemlist, slotState, ...per item], or [1111, error, code,
// itemlist]. Client 22's 0x7800 handler (FUN_005f8aa0) shows a message box per error: 74070 (and -1) = m134 "This
// WarRock nickname has already been taken", 74100 = m134_7 (length/characters, Korean text only), 74110 = m134_8
// (forbidden word, Korean only), 74030 = m134_6 (empty). Without a reply the inventory window stays waiting.
const USE_ERROR = { NAME_TAKEN: 74070, NAME_FORMAT: 74100 };

function resetKillDeath(db, u) {
  u.kills = 0;
  u.deaths = 0;
  db.query('UPDATE user_details SET kills = 0, deaths = 0 WHERE id = ?', [u.id]).catch((err) =>
    console.error('shop: failed to persist kill/death reset:', err.message)
  );
  removeItem(db, u, 'CB03');
}

async function handleUseItem(socket, db, u, pkt) {
  const itemCode = String(pkt.blocks[3] || '').toUpperCase();
  if (!ownsItem(u.inventory, itemCode)) return;
  const refuse = (code) => socket.sendPacket(CASH_ITEM, [USE_ITEM, code, itemCode, buildItemlist(u.inventory)]);

  if (itemCode === 'CB03') {
    resetKillDeath(db, u);
    return socket.sendPacket(CASH_ITEM, [USE_ITEM, 1, itemCode, buildItemlist(u.inventory), buildSlotState(u, u.inventory), 0, 0, u.money]);
  }

  if (itemCode === 'CB01') {
    const nickname = String(pkt.blocks[4] || '').trim();
    if (!NICKNAME_RE.test(nickname)) return refuse(USE_ERROR.NAME_FORMAT);
    if (RESERVED_RE.test(nickname)) return refuse(USE_ERROR.NAME_TAKEN); // as if taken: the English client has no other text
    const entry = u.inventory.get(itemCode);
    if (entry.busy) return; // a second packet while the first rename is still checking the name
    entry.busy = true;
    const renamed = await renameDisplayname(u, nickname).finally(() => delete entry.busy);
    if (!renamed) return refuse(USE_ERROR.NAME_TAKEN);
    removeItem(db, u, itemCode);
    return socket.sendPacket(CASH_ITEM, [USE_ITEM, 1, itemCode, buildItemlist(u.inventory), buildSlotState(u, u.inventory), u.displayname]);
  }
}

function handleCashItem(db) {
  return (socket, pkt) => {
    const u = socket.user;
    if (u && Number(pkt.blocks[0]) === USE_ITEM) return handleUseItem(socket, db, u, pkt);
  };
}

// Ported from Itemshop.cs's Process(), validation order preserved. Buying an owned (non-retail) item renews it: the
// reference inserts a second user_inventory row and extends only memory, so the expiry could go back at the next login;
// here the existing row's length grows, from the current expiry.
function handleItemshop(db) {
  return (socket, pkt) => {
    const u = socket.user;
    if (!u) return;

    const actionType = Number(pkt.blocks[0]);
    if (actionType === USE_ITEM) {
      const code = String(pkt.blocks[1] || '').toUpperCase();
      if (code !== 'CB03' || !ownsItem(u.inventory, code)) return sendError(socket, ERROR.INVALID_ITEM); // "item is no longer valid"
      resetKillDeath(db, u);
      return sendSuccess(socket, u, USE_ITEM);
    }
    if (actionType !== BUY_ITEM) return sendError(socket, ERROR.INVALID_ITEM); // anything else - likely cheating, matches the reference

    const itemCode = (pkt.blocks[1] || '').toUpperCase();
    const lengthIdx = Number(pkt.blocks[4]);
    const item = getItem(itemCode);

    if (itemCode.length !== 4 || !item || !(lengthIdx >= 0 && lengthIdx < DAYS.length)) {
      return socket.end(); // reference treats a malformed/unknown request here as likely cheating
    }
    if (!item.buyable) return sendError(socket, ERROR.CANNOT_BE_BOUGHT);
    if (u.inventory.size >= MAX_ITEMS) return sendError(socket, ERROR.INVENTORY_FULL);
    if (item.reqPremium && u.premium <= 0) return sendError(socket, ERROR.PREMIUM_ONLY);
    if (item.reqLevel > levelForXp(u.xp)) return sendError(socket, ERROR.LEVEL_REQUIREMENT);

    const price = item.cost[lengthIdx];
    if (!(price >= 0)) return socket.end(); // not sellable for that lease length

    if (u.money < price) return sendError(socket, ERROR.NOT_ENOUGH_DINAR);
    const owned = ownsItem(u.inventory, itemCode) ? u.inventory.get(itemCode) : null;
    // Retail items never expire; busy = a buy or renewal of this item is still being stored.
    if (owned && (owned.retail || owned.busy)) return sendError(socket, ERROR.CANNOT_BE_BOUGHT);

    // Memory first, so a second buy packet arriving meanwhile already sees the new balance/item. The charge and the
    // item are one transaction, and the client hears "bought" only once it is stored; on failure memory is undone.
    const lengthSeconds = 86400 * DAYS[lengthIdx];
    u.money -= price;
    if (owned) Object.assign(owned, { expireDate: owned.expireDate + lengthSeconds, busy: true });
    else u.inventory.set(itemCode, { expireDate: Number.MAX_SAFE_INTEGER, retail: false, busy: true }); // grantItem replaces it
    return db
      .transaction(async (conn) => {
        const [res] = await conn.query('UPDATE user_details SET money = money - ? WHERE id = ? AND money >= ?', [price, u.id, price]);
        if (res.affectedRows !== 1) throw new Error('balance in DB lower than in memory');
        if (!owned) return grantItem(conn, u, itemCode, DAYS[lengthIdx]);
        const [row] = await conn.query(
          'UPDATE user_inventory SET length = length + ? WHERE owner = ? AND code = ? AND expired = 0 AND deleted = 0 ORDER BY startdate + length DESC LIMIT 1',
          [lengthSeconds, u.id, itemCode]
        );
        if (row.affectedRows !== 1) throw new Error('owned item missing in DB');
      })
      .then(
        () => {
          if (owned) delete owned.busy;
          sendSuccess(socket, u);
        },
        (err) => {
          console.error(`shop: purchase of ${itemCode} by ${u.id} not stored:`, err.message);
          u.money += price;
          if (owned) Object.assign(owned, { expireDate: owned.expireDate - lengthSeconds, busy: undefined });
          else u.inventory.delete(itemCode);
          sendError(socket, ERROR.CANNOT_BE_BOUGHT);
        }
      );
  };
}

module.exports = { validNickname, handleItemshop, handleCashItem, ITEMSHOP, CASH_ITEM, sendSuccess, grantItem, removeItem, setAuthDb };
