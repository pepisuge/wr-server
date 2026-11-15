-- Records which sql/ patches a database has. Patches are applied in order, so this one marks 03..12 as done.
-- Every later patch ends with: INSERT IGNORE INTO wres2.schema_version (version) VALUES (<its number>);
-- and node/game-server.js's SCHEMA_VERSION is bumped to match (it warns at boot when the DB is behind).
CREATE TABLE IF NOT EXISTS wres2.schema_version (
  version smallint unsigned NOT NULL PRIMARY KEY,
  applied_at timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB;
INSERT IGNORE INTO wres2.schema_version (version) VALUES (3),(4),(5),(6),(7),(8),(9),(10),(11),(12);
