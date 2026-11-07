-- Schema the Node server needs on top of the Chapter-1 GameServer.SQL dump.
-- Game DB (wres2). Safe to re-run: no DROP, IF NOT EXISTS everywhere (MariaDB).

-- GM rights (set by hand, never by the client) and chat mute expiry (unix seconds).
-- See docs/protocol/economy.md (GM commands).
ALTER TABLE user_details
  ADD COLUMN IF NOT EXISTS is_gm tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mutedexpire bigint(20) unsigned NOT NULL DEFAULT 0;

-- One row per redeemed coupon, so the same account can't redeem it twice.
-- See docs/protocol/economy.md (coupons).
CREATE TABLE IF NOT EXISTS user_coupons (
  owner int(10) unsigned NOT NULL,
  coupon_id int(10) unsigned NOT NULL,
  redeemed_at int(10) unsigned NOT NULL,
  PRIMARY KEY (owner, coupon_id)
) ENGINE=InnoDB;
