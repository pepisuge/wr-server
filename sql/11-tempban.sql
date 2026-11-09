-- Temporary bans (GM /tempban). Login DB (masterserver). Safe to re-run (MariaDB IF NOT EXISTS).
-- status <= 0 is still "banned"; with ban_until > 0 (unix seconds) the login lifts it once that time has passed.
ALTER TABLE masterserver.users
  ADD COLUMN IF NOT EXISTS ban_until bigint(20) unsigned NOT NULL DEFAULT 0;
