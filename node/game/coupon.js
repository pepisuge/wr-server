// Ported from Game/Handlers/Coupon.cs + Game/Packets/Coupon.cs + Managers/CouponManager.cs.
// A real, complete feature in the reference - unlike clan/clan-war/GM
// commands, nothing here is invented protocol.
const { ownsItem } = require('./inventory');
const { sendSuccess: sendShopSuccess, grantItem } = require('./shop');

// Client 22's packet table (FUN_005fefa0) registers 0x7910 (and 0x7920 level-up) and has NO 0x8100: PF-20's 0x8100 is wrong for it.
// SGMartin/Servidor-Chapter-1-WarRock (PF-23) uses 0x7910 too. Same id both ways, as for Chat, Equipment, RoomJoin, ...
const COUPON = 0x7910;

// code -> { id, code, uses, dinarReward, itemReward: [{code, days}] }
const coupons = new Map();

async function loadCoupons(db) {
  const [rows] = await db.query('SELECT id, code, uses, dinarreward, itemreward FROM coupons');
  coupons.clear();
  for (const r of rows) {
    const itemReward = String(r.itemreward || '')
      .split(',')
      .map((entry) => entry.split('-'))
      .filter(([code, days]) => code && code.length === 4 && Number.isInteger(Number(days)))
      .map(([code, days]) => ({ code: code.toUpperCase(), days: Number(days) }));
    coupons.set(r.code, { id: r.id, code: r.code, uses: Number(r.uses), dinarReward: Number(r.dinarreward), itemReward });
  }
  console.log(`Coupons: loaded ${coupons.size} catalog entries.`);
}

// Loaded at authorization (same moment as inventory/equipment) into
// u.redeemedCoupons - a real gap in the reference: it never tracks who
// redeemed what, so an infinite-use coupon can be repeated forever by the
// same account. Closed here with a small guard table, not ported as-is.
async function loadRedeemedCoupons(db, userId) {
  const [rows] = await db.query('SELECT coupon_id FROM user_coupons WHERE owner = ?', [userId]);
  return new Set(rows.map((r) => r.coupon_id));
}

function reply(socket, success, dinars) {
  socket.sendPacket(COUPON, [success, 0, dinars]);
}

function handleCoupon(db) {
  return (socket, pkt) => {
    const u = socket.user;
    if (!u) return;

    const code = pkt.blocks[0] || '';
    const coupon = coupons.get(code);
    if (!coupon) return reply(socket, -2, 0); // invalid code

    if (coupon.uses === 0 || u.redeemedCoupons.has(coupon.id)) {
      return reply(socket, -1, 0); // out of uses (or: you already used this one - same wire code, no new one invented)
    }

    // Memory first (a second redeem packet meanwhile is refused), then redemption + dinars + items + uses in one
    // transaction; the client is answered only once it is stored, and memory is undone if it isn't.
    // No renewal of an item already owned (same simplification as shop.js).
    const items = coupon.itemReward.filter(({ code: itemCode }) => !ownsItem(u.inventory, itemCode));
    u.redeemedCoupons.add(coupon.id);
    u.money += coupon.dinarReward;
    if (coupon.uses > 0) coupon.uses -= 1;

    return db
      .transaction(async (conn) => {
        await conn.query('INSERT INTO user_coupons (owner, coupon_id, redeemed_at) VALUES (?, ?, ?)', [u.id, coupon.id, Math.floor(Date.now() / 1000)]);
        if (coupon.dinarReward > 0) await conn.query('UPDATE user_details SET money = money + ? WHERE id = ?', [coupon.dinarReward, u.id]);
        for (const { code: itemCode, days } of items) await grantItem(conn, u, itemCode, days);
        await conn.query('UPDATE coupons SET uses = uses - 1 WHERE id = ? AND uses > 0', [coupon.id]);
      })
      .then(
        () => {
          if (coupon.dinarReward > 0) reply(socket, 0, u.money);
          // The reference answers item rewards with the Itemshop success packet, one per item.
          for (let i = 0; i < items.length; i++) sendShopSuccess(socket, u);
        },
        (err) => {
          console.error(`coupon: redemption of ${coupon.id} by ${u.id} not stored:`, err.message);
          u.redeemedCoupons.delete(coupon.id);
          u.money -= coupon.dinarReward;
          if (coupon.uses >= 0) coupon.uses += 1;
          for (const { code: itemCode } of items) u.inventory.delete(itemCode);
          reply(socket, -2, 0);
        }
      );
  };
}

module.exports = { loadCoupons, loadRedeemedCoupons, handleCoupon, COUPON };
