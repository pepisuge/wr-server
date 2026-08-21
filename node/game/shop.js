// Ported from Game/Handlers/Itemshop.cs + Game/Packets/Itemshop.cs. Unlike
// clan.js/gm.js, this is a real port, not an invented protocol - the
// reference has a complete, working shop.
const { levelForXp } = require('./progression');
const { getItem } = require('./items');
const { ownsItem, buildItemlist, buildSlotState, MAX_ITEMS } = require('./inventory');

const ITEMSHOP = 0x7600;
const BUY_ITEM = 0x456; // Enums.ItemAction.BuyItem
const USE_ITEM = 0x457; // Enums.ItemAction.UseItem - never implemented in the reference either

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

function sendSuccess(socket, u) {
  socket.sendPacket(ITEMSHOP, [
    1,
    BUY_ITEM,
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
    if (actionType !== BUY_ITEM) {
      // USE_ITEM and anything else - matches the reference, which never
      // implemented USE_ITEM either.
      return sendError(socket, ERROR.INVALID_ITEM);
    }

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

module.exports = { handleItemshop, ITEMSHOP, sendSuccess, grantItem };
