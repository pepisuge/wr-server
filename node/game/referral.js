// Referral (#34): every level an invited player gains gives both players REWARD_DAYS of Bronze premium (a higher
// active tier is kept, never downgraded). Each level pays once (referrals.paid_level); at most MAX_REWARDED invites
// per inviter earn rewards; nothing is paid while the two share an IP (registration or last login).
const { users } = require('./state');
const { effectivePremium, PREMIUM } = require('./progression');

const REWARD_DAYS = 3;
const MAX_REWARDED = 3;
let authDb = null; // masterserver pool, for the IPs (game-server.js sets it)

function setAuthDb(pool) {
  authDb = pool;
}

// The two accounts look like one person: any registration / last-login IP in common.
function sameIp(a, b) {
  const ips = (u) => [u.register_ip, u.last_login_ip].filter(Boolean);
  return ips(a).some((ip) => ips(b).includes(ip));
}

// How many levels to pay now (0 = none) and whether to mark them as handled.
function rewardLevels({ paidLevel, newLevel, inviterRewarded, shareIp }) {
  const levels = newLevel - paidLevel;
  if (levels <= 0) return { levels: 0, advance: false };
  if (shareIp) return { levels: 0, advance: true }; // burnt: switching IP later does not pay them back
  // an invite that never paid yet does not start once the inviter has MAX_REWARDED rewarded ones
  if (paidLevel <= 1 && inviterRewarded >= MAX_REWARDED) return { levels: 0, advance: false };
  return { levels, advance: true };
}

// Premium after adding `days`: Bronze unless a higher tier is still active; the time adds to what is left.
function extendPremium(row, days, now = Math.floor(Date.now() / 1000)) {
  const { premium, expireDate } = effectivePremium(row, now);
  return { premium: Math.max(premium, PREMIUM.BRONZE), premium_expiredate: Math.max(expireDate, now) + days * 86400 };
}

async function onLevelUp(db, inviteeId, newLevel) {
  const [[link]] = await db.query('SELECT inviter FROM referrals WHERE invitee = ?', [inviteeId]);
  if (!link || !authDb) return;
  const [accounts] = await authDb.query('SELECT id, register_ip, last_login_ip FROM users WHERE id IN (?, ?)', [inviteeId, link.inviter]);
  const invitee = accounts.find((a) => Number(a.id) === Number(inviteeId));
  const inviter = accounts.find((a) => Number(a.id) === Number(link.inviter));
  if (!invitee || !inviter) return;

  const ids = [Number(inviteeId), Number(link.inviter)];
  const paid = await db.transaction(async (conn) => {
    const [[ref]] = await conn.query('SELECT paid_level FROM referrals WHERE invitee = ? FOR UPDATE', [inviteeId]);
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM referrals WHERE inviter = ? AND paid_level > 1 AND invitee <> ?', [link.inviter, inviteeId]);
    const { levels, advance } = rewardLevels({ paidLevel: ref.paid_level, newLevel, inviterRewarded: Number(n), shareIp: sameIp(invitee, inviter) });
    if (advance) await conn.query('UPDATE referrals SET paid_level = ? WHERE invitee = ?', [newLevel, inviteeId]);
    if (!levels) return 0;
    const [rows] = await conn.query('SELECT id, premium, premium_expiredate FROM user_details WHERE id IN (?, ?) FOR UPDATE', ids);
    for (const row of rows) {
      const next = extendPremium(row, levels * REWARD_DAYS);
      await conn.query('UPDATE user_details SET premium = ?, premium_expiredate = ? WHERE id = ?', [next.premium, next.premium_expiredate, row.id]);
      const u = [...users.values()].find((x) => Number(x.id) === Number(row.id));
      if (u) Object.assign(u, { premium: next.premium, premiumExpireDate: next.premium_expiredate });
    }
    return levels;
  });
  if (!paid) return;
  const chat = require('./chat'); // lazy: chat.js -> gm.js -> rooms.js -> progression.js
  for (const u of users.values()) {
    if (ids.includes(Number(u.id))) chat.sendSystemWhisper(u.socket, `Referral: +${paid * REWARD_DAYS} days of premium.`);
  }
}

module.exports = { setAuthDb, onLevelUp, rewardLevels, extendPremium, sameIp, REWARD_DAYS, MAX_REWARDED };
