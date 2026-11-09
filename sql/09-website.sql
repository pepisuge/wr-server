-- Website registration (node/game/web.js). Login DB (masterserver).
-- Unique names so two concurrent sign-ups can't create the same account. Safe to re-run (MariaDB IF NOT EXISTS).
ALTER TABLE masterserver.users
  ADD UNIQUE INDEX IF NOT EXISTS ux_users_username (username),
  ADD UNIQUE INDEX IF NOT EXISTS ux_users_displayname (displayname);
