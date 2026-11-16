-- Referral (#34): "Invited by" at registration; every level the invited player gains gives both 3 days of Bronze
-- premium (node/game/referral.js). IPs keep it from being farmed with one's own second account.
ALTER TABLE masterserver.users
  ADD COLUMN IF NOT EXISTS register_ip VARCHAR(45) NULL,
  ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45) NULL;
CREATE TABLE IF NOT EXISTS wres2.referrals (
  invitee BIGINT NOT NULL PRIMARY KEY,
  inviter BIGINT NOT NULL,
  paid_level TINYINT UNSIGNED NOT NULL DEFAULT 1, -- last level of the invitee already rewarded
  KEY ix_referrals_inviter (inviter)
);
INSERT IGNORE INTO wres2.schema_version (version) VALUES (17);
