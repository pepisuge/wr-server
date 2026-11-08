// Fase 5 (livelli/XP) + Fase 6 (premium), ported from Core/LevelCalculator.cs,
// Game/Enums/Premium.cs, Game/Entities/{User,Player}.cs and the `gameconfig`
// table. Kept in one module since the XP formula is premium-rate-dependent.
const { ownsItem } = require('./inventory');

// EXPTable from Core/LevelCalculator.cs, verbatim (index = level-1, last
// entry is a sentinel so level caps at 100).
const EXP_TABLE = [
  0, 2250, 6750, 11250, 16650, 24750, 32850, 41625, 50400, 59175,
  67950, 76725, 94725, 112725, 130725, 148725, 166725, 189225, 211725, 234225,
  256725, 279225, 306225, 333225, 360225, 387225, 414225, 441225, 497475, 553725,
  609975, 666225, 722475, 778725, 857475, 936225, 1014975, 1093725, 1172475, 1251225,
  1363725, 1476225, 1588725, 1701225, 1813725, 1926225, 2038725, 2207475, 2376225, 2544975,
  2713725, 2882475, 3051225, 3219975, 3444975, 3669975, 3894975, 4119975, 4344975, 4569975,
  4794975, 5132475, 5469975, 5807475, 6144975, 6482475, 6819975, 7157475, 7494975, 7944975,
  8394975, 8844975, 9294975, 9744975, 10194975, 10644975, 11094975, 11657475, 12219975, 12782475,
  13344975, 13907475, 14469975, 15032475, 15932475, 17282475, 18632475, 19982475, 21332475, 22682475,
  24032475, 25382475, 26732475, 28307475, 29882475, 31457475, 33032475, 34607475, 36182475, 37757475,
  2147483647,
];

function levelForXp(xp) {
  for (let lvl = 0; lvl < 101; lvl++) {
    if (xp < EXP_TABLE[lvl]) return lvl;
  }
  return 100; // xp >= sentinel - practically unreachable, cap instead of overflowing to 101
}

// Inverse of levelForXp, ported from LevelCalculator.cs's GetExpForLevel.
function xpForLevel(level) {
  const lvl = Math.max(1, Math.min(100, Math.floor(level)));
  return EXP_TABLE[lvl - 1];
}

// Room level-limit codes, ported from RoomCreation.cs/RoomJoin.cs SuitableLevel.
function suitableLevel(levelLimit, playerLevel) {
  switch (Number(levelLimit)) {
    case 0: return true;
    case 1: return playerLevel >= 1 && playerLevel <= 10;
    case 2: return playerLevel >= 11;
    case 3: return playerLevel >= 21;
    case 4: return playerLevel >= 31;
    case 5: return playerLevel >= 41;
    default: return false;
  }
}

// Game/Enums/Premium.cs.
const PREMIUM = { FREE2PLAY: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 };

// Player.cs's PremiumBonus array, only defined for indices 0-3 in the
// reference (Platinum=4 would throw IndexOutOfRangeException there) -
// falling back to 0 instead of crashing until Platinum gets a real rate.
const PREMIUM_XP_BONUS = [0, 0.2, 0.3, 0.5];
function premiumXpBonus(premium) {
  return PREMIUM_XP_BONUS[premium] ?? 0;
}

// gameconfig table - loaded once at boot (Game/GameConfig.cs's pattern),
// mutated in place so callers holding a reference see updates. bombTime/
// explosiveRoundTime/allowStartAlone are Explosive mode's (Fase 27) -
// GameConfig.cs's own defaults if the DB row is somehow missing them.
const GameConfig = {
  expRate: 1,
  dinarRate: 1,
  levelUpMoneyReward: 25000,
  bombTime: 45000,
  explosiveRoundTime: 180000,
  allowStartAlone: false,
};
async function loadGameConfig(db) {
  const [rows] = await db.query(
    'SELECT exprate, dinarrate, levelup_base_reward, bombtime, explosivetime, allow_start_alone FROM gameconfig LIMIT 1'
  );
  if (rows[0]) {
    GameConfig.expRate = Number(rows[0].exprate) || 1;
    GameConfig.dinarRate = Number(rows[0].dinarrate) || 1;
    GameConfig.levelUpMoneyReward = Number(rows[0].levelup_base_reward) || 25000;
    GameConfig.bombTime = Number(rows[0].bombtime) || 45000;
    GameConfig.explosiveRoundTime = Number(rows[0].explosivetime) || 180000;
    GameConfig.allowStartAlone = !!rows[0].allow_start_alone;
  }
}

// Ported from Game/Entities/User.cs's Load(): one row per account, created
// with the reference's defaults (money=50000) on first game-server login.
async function loadUserDetails(db, userId) {
  const [rows] = await db.query(
    'SELECT xp, money, kills, deaths, premium, premium_expiredate, clanid, clanrank, is_gm, mutedexpire FROM user_details WHERE id = ?',
    [userId]
  );
  if (rows[0]) return rows[0];
  await db.query(
    'INSERT INTO user_details (id, kills, deaths, headshots, xp, money, premium, premium_expiredate, play_time, rounds_played, bombs_planted, bombs_defused, clanid, clanrank, flags_taken, wins, losses, vehicles_destroyed) VALUES (?, 0,0,0,0,50000,0,0,0,0,0,0,0,0,0,0,0,0)',
    [userId]
  );
  return loadUserDetails(db, userId);
}

// Ported from User.cs's UpdatePremiumState(): premium only counts while
// premium_expiredate is still in the future, otherwise it's Free2Play.
function effectivePremium(row, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expireDate = Number(row.premium_expiredate);
  if (Number(row.premium) > 0 && expireDate > nowSeconds) {
    return { premium: Number(row.premium), expireDate, timeLeft: expireDate - nowSeconds };
  }
  return { premium: PREMIUM.FREE2PLAY, expireDate: 0, timeLeft: 0 };
}

// Live mid-session counterpart to effectivePremium() (which only runs once,
// at login): called periodically (see ping.js) so a premium that expires
// while a player is still connected actually stops applying instead of
// staying in effect until their next login. Returns true only on the
// transition to expired, so the caller notifies once, not every tick.
function checkPremiumExpiry(db, user, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (user.premium <= 0 || user.premiumExpireDate > nowSeconds) return false;

  user.premium = PREMIUM.FREE2PLAY;
  user.premiumExpireDate = 0;
  db.query('UPDATE user_details SET premium = 0, premium_expiredate = 0 WHERE id = ?', [user.id]).catch((err) =>
    console.error('checkPremiumExpiry: failed to persist:', err.message)
  );
  return true;
}

// CC03/CC04 (UP_EXP/UP_DINAR): real item codes, but never wired to any
// multiplier in either C# reference - ToXiiC-Core's gameserver.xml even has
// <EXPBonus>0.3</EXPBonus>/<DinarBonus>0.3</DinarBonus>, but no .cs file
// reads them. Self-designed from here down (not a port - see the guide):
// reusing those same 0.3 reference values rather than inventing new ones,
// applied for as long as the item is owned (same leased-item mechanic as
// everything else in the shop, no separate activate/consume step needed).
const BOOSTER_XP_BONUS = 0.3;
const BOOSTER_DINAR_BONUS = 0.3;

// Ported from Player.cs's scoring branch + User.cs's EndGame(). points
// defaults to 0 (a mid-match room-leave with no kills to show for it);
// roundtimer.js's endRound() passes real kill counts now that those exist
// (see gamesubs.js's PlayerDamage). Persists xp+money to DB (the reference
// only persists money from this path - persisting xp too is a deliberate
// fix, otherwise levels would never survive a restart).
function applyMatchEnd(db, user, points = 0) {
  const expRate = 1 + premiumXpBonus(user.premium) + (ownsItem(user.inventory, 'CC03') ? BOOSTER_XP_BONUS : 0);
  const dinarRate = 1 + (ownsItem(user.inventory, 'CC04') ? BOOSTER_DINAR_BONUS : 0);

  const xpEarned = Math.ceil((20 + points * 4 * expRate) * GameConfig.expRate);
  const moneyEarned = Math.ceil((50 + points * 3 * dinarRate) * GameConfig.dinarRate);

  const oldLevel = levelForXp(user.xp);
  user.xp += xpEarned;
  user.money += moneyEarned;
  const newLevel = levelForXp(user.xp);

  let levelUp = null;
  if (newLevel > oldLevel) {
    const bonusMoney = (newLevel - oldLevel) * GameConfig.levelUpMoneyReward;
    user.money += bonusMoney;
    levelUp = { newLevel, xp: user.xp, bonusMoney };
  }

  // Relative, not absolute: absolute writes issued in sequence can land out of order and overwrite a newer balance.
  const moneyGained = moneyEarned + (levelUp ? levelUp.bonusMoney : 0);
  db.query('UPDATE user_details SET xp = xp + ?, money = money + ? WHERE id = ?', [xpEarned, moneyGained, user.id]).catch((err) =>
    console.error('applyMatchEnd: failed to persist xp/money:', err.message)
  );

  return { xpEarned, moneyEarned, levelUp };
}

module.exports = {
  PREMIUM,
  GameConfig,
  levelForXp,
  xpForLevel,
  suitableLevel,
  premiumXpBonus,
  loadGameConfig,
  loadUserDetails,
  effectivePremium,
  checkPremiumExpiry,
  applyMatchEnd,
};
