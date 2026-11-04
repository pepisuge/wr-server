// Ported from Game/Handlers/Itemshop.cs + Game/Packets/Itemshop.cs. Unlike
// clan.js/gm.js, this is a real port, not an invented protocol - the
// reference has a complete, working shop.
const { levelForXp } = require('./progression');
const { getItem } = require('./items');
const { ownsItem, buildItemlist, buildSlotState, MAX_ITEMS } = require('./inventory');

const ITEMSHOP = 0x7600;
const BUY_ITEM = 0x456; // Enums.ItemAction.BuyItem
// USE_ITEM looked unimplemented in Chapter-1-Server - but ToXiiC-Core's
// CashItemBuy.cs has a real OnItemUse=1111 (=0x457) handler, same trap as
// the GM commands (CLAUDE.md). Only CB01 (rename) and CB03 (kill/death
// reset) are ported below - the reference's other cases (CZ73 ham radio,
// CC56/57/36/37+CZ99+CR16+CR05 random/gift boxes) need a package-reward
// system this schema has no tables for, and are left unhandled.
const USE_ITEM = 0x457;

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

const DAYS = [3, 7, 15, 30]; // item_shop.cost is indexed by this, index 4 = "permanent"

function sendError(socket, code) {
  socket.sendPacket(ITEMSHOP, [code]);
}

// actionType defaults to BUY_ITEM (the only caller until USE_ITEM below) -
// both actions end in the same "here's your fresh inventory/money" resync,
// so this one shape covers both instead of a second near-duplicate builder.
function sendSuccess(socket, u, actionType = BUY_ITEM) {
  socket.sendPacket(ITEMSHOP, [
    1,
    actionType,
    -1,
    3,
    u.inventory.size,
    buildItemlist(u.inventory),
    u.money,
    buildSlotState(u, u.inventory),
  ]);
}

// Shared with coupon.js: adds one item to a user's inventory (memory first,
// DB fire-and-forget after) without touching money - the buy flow below
// deducts price itself before calling this, coupon grants are free.
function grantItem(db, u, code, days) {
  const now = Math.floor(Date.now() / 1000);
  const lengthSeconds = 86400 * days;
  u.inventory.set(code, { expireDate: now + lengthSeconds, retail: false });
  db.query(
    'INSERT INTO user_inventory (owner, code, startdate, length, price, expired, deleted) VALUES (?, ?, ?, ?, 0, 0, 0)',
    [u.id, code, now, lengthSeconds]
  ).catch((err) => console.error('shop: failed to persist granted item:', err.message));
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
async function renameDisplayname(u, nickname) {
  if (!authDb) return false;
  const [existing] = await authDb.query('SELECT id FROM users WHERE displayname = ? AND id != ?', [nickname, u.id]);
  if (existing.length) return false;
  u.displayname = nickname;
  authDb
    .query('UPDATE users SET displayname = ? WHERE id = ?', [nickname, u.id])
    .catch((err) => console.error('shop: failed to persist nickname change:', err.message));
  return true;
}

// items.bin's `users.displayname` column is varchar(16); IsAlphaNumeric in
// the reference has no length check of its own, just the column width.
const NICKNAME_RE = /^[a-zA-Z0-9]{3,16}$/;

async function handleUseItem(socket, db, u, pkt) {
  const itemCode = (pkt.blocks[1] || '').toUpperCase();
  if (!ownsItem(u.inventory, itemCode)) return sendError(socket, ERROR.INVALID_ITEM);

  if (itemCode === 'CB03') {
    // INI_KILLDEATH - Managers/CashItemBuy.cs's OnItemUse "CB03" case.
    u.kills = 0;
    u.deaths = 0;
    db.query('UPDATE user_details SET kills = 0, deaths = 0 WHERE id = ?', [u.id]).catch((err) =>
      console.error('shop: failed to persist kill/death reset:', err.message)
    );
    removeItem(db, u, itemCode);
    return sendSuccess(socket, u, USE_ITEM);
  }

  if (itemCode === 'CB01') {
    // Wire layout for this param is inferred from BUY_ITEM's own
    // [action, code, ...] shape (9.3), not yet confirmed against a live
    // capture - CLAUDE.md's rule (real client wins over the reference)
    // applies here as soon as one is available.
    const nickname = (pkt.blocks[2] || '').trim();
    if (!NICKNAME_RE.test(nickname)) return sendError(socket, ERROR.INVALID_ITEM);
    const renamed = await renameDisplayname(u, nickname);
    if (!renamed) return sendError(socket, ERROR.CANNOT_BE_BOUGHT); // name taken - reference has no dedicated error code either
    removeItem(db, u, itemCode);
    return sendSuccess(socket, u, USE_ITEM);
  }

  // Any other code - matches the reference's still-unported cases (ham
  // radio, random/gift boxes) by doing nothing, same as an unknown code.
  return sendError(socket, ERROR.INVALID_ITEM);
}

// Ported from Itemshop.cs's Process(), validation order preserved exactly -
// only the "already own a non-retail item" branch differs: the reference
// renews it there (and does so by inserting a *second* user_inventory row
// instead of updating the first, a real bug that lets DB and in-memory
// expiry drift apart over repeated renewals) - simplified here to a flat
// rejection until renewal is actually needed (see the plan).
function handleItemshop(db) {
  return (socket, pkt) => {
    const u = socket.user;
    if (!u) return;

    const actionType = Number(pkt.blocks[0]);
    if (actionType === USE_ITEM) return handleUseItem(socket, db, u, pkt);
    if (actionType !== BUY_ITEM) return sendError(socket, ERROR.INVALID_ITEM); // anything else - likely cheating, matches the reference

    const itemCode = (pkt.blocks[1] || '').toUpperCase();
    const lengthIdx = Number(pkt.blocks[4]);
    const item = getItem(itemCode);

    if (itemCode.length !== 4 || !item || !(lengthIdx >= 0 && lengthIdx < 4)) {
      return socket.end(); // reference treats a malformed/unknown request here as likely cheating
    }
    if (!item.buyable) return sendError(socket, ERROR.CANNOT_BE_BOUGHT);
    if (u.inventory.size >= MAX_ITEMS) return sendError(socket, ERROR.INVENTORY_FULL);
    if (item.reqPremium && u.premium <= 0) return sendError(socket, ERROR.PREMIUM_ONLY);
    if (item.reqLevel > levelForXp(u.xp)) return sendError(socket, ERROR.LEVEL_REQUIREMENT);

    const price = item.cost[lengthIdx];
    if (!(price >= 0)) return socket.end(); // not sellable for that lease length

    if (u.money < price) return sendError(socket, ERROR.NOT_ENOUGH_DINAR);
    if (ownsItem(u.inventory, itemCode)) return sendError(socket, ERROR.CANNOT_BE_BOUGHT);

    // Memory first (source of truth for the reply below and for any
    // immediately-following packet), DB write fire-and-forget after - same
    // pattern as clan.js/gm.js, avoids the same kind of same-tick race.
    u.money -= price;
    db.query('UPDATE user_details SET money = ? WHERE id = ?', [u.money, u.id]).catch((err) =>
      console.error('shop: failed to persist money:', err.message)
    );
    grantItem(db, u, itemCode, DAYS[lengthIdx]);

    sendSuccess(socket, u);
  };
}

module.exports = { handleItemshop, ITEMSHOP, sendSuccess, grantItem, removeItem, setAuthDb };
