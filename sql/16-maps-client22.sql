-- Map ids 37-39 as client 22 has them (maps/*/MapInfo.xml): the reference dump had other maps there (Disturm, Artifact,
-- Winter Forest) plus 40-43 (Decay, LostTemple, KalyeDos, NightMarien) that the client does not have.
-- flag_count / flag_state (team 0 - team 1 spawn flag index) come from each map's ControlPointTemplate.dat,
-- vehiclecount from ObjectSpawnTemplate.dat. Pay type stays 0 like every other row (the server does not enforce it).
-- 37/38 need the client mod's MapList.xml edits (both are disabled there; 39 GRUNDEL is missing from the list).

REPLACE INTO wres2.map_data (id, name, flag_count, flag_state, channels, gamemode, restriction_pay_type, vehiclecount) VALUES
  (37, 'BlocHalloween', 2, '1-0', 'T,F,F,F', 'T,F,F,8,F', '0', 0),
  (38, 'X-Velruf', 2, '1-0', 'T,F,F,F', 'T,F,F,8,F', '0', 0),
  (39, 'Grendel', 10, '0-1', 'F,F,T,F', 'F,T,T,0,F', '0', 23);
DELETE FROM wres2.map_data WHERE id BETWEEN 40 AND 43;
INSERT IGNORE INTO wres2.schema_version (version) VALUES (16);
