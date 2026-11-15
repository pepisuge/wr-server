-- PX items with a working effect in client 22 but buyable = 0 in the reference dump: stamina (DS03, slot 6 like the
-- adrenaline; CF02 +stamina extra) and the sniper/assault scopes (CG01/CG02, applied by the client from the inventory,
-- FUN_004c2d60). Prices are the dump's own cost lists.

UPDATE wres2.item_weapons SET active = 1 WHERE code = 'DS03';
UPDATE wres2.item_extra SET active = 1 WHERE code IN ('CF02', 'CG01', 'CG02');
UPDATE wres2.item_shop SET buyable = 1 WHERE code IN ('DS03', 'CF02', 'CG01', 'CG02');
INSERT IGNORE INTO wres2.schema_version (version) VALUES (14);
