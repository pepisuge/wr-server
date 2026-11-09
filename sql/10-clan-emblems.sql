-- Clan emblems chosen or uploaded on the website (node/game/web.js). Game DB (wres2). Safe to re-run (MariaDB).
-- emblem: NULL = default gallery emblem picked from the name, 'g<n>' = gallery emblem n, 'u' = uploaded image.
ALTER TABLE clan
  ADD COLUMN IF NOT EXISTS emblem varchar(8) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS emblem_data mediumblob NULL DEFAULT NULL;
