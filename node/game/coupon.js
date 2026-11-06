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

    u.redeemedCoupons.add(coupon.id);
    db.query('INSERT INTO user_coupons (owner, coupon_id, redeemed_at) VALUES (?, ?, ?)', [
      u.id,
      coupon.id,
      Math.floor(Date.now() / 1000),
    ]).catch((err) => console.error('coupon: failed to persist redemption:', err.message));

    if (coupon.dinarReward > 0) {
      u.money += coupon.dinarReward;
      db.query('UPDATE user_details SET money = ? WHERE id = ?', [u.money, u.id]).catch((err) =>
        console.error('coupon: failed to persist money:', err.message)
      );
      reply(socket, 0, u.money);
    }

    // Reference reuses the Itemshop success packet for item rewards instead
    // of its own Coupon packet - ported as-is, reusing shop.js's own
    // grant/reply helpers rather than rebuilding them here.
    for (const { code: itemCode, days } of coupon.itemReward) {
      if (ownsItem(u.inventory, itemCode)) continue; // simplification: no renewal, see the plan (same as shop.js)
      grantItem(db, u, itemCode, days);
      sendShopSuccess(socket, u);
    }

    if (coupon.uses > 0) {
      coupon.uses -= 1;
      db.query('UPDATE coupons SET uses = ? WHERE id = ?', [coupon.uses, coupon.id]).catch((err) =>
        console.error('coupon: failed to persist uses:', err.message)
      );
    }
  };
}

module.exports = { loadCoupons, loadRedeemedCoupons, handleCoupon, COUPON };
