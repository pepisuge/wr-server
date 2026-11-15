-- PX items with a working effect in client 22 but buyable = 0 in the reference dump: stamina (DS03, slot 6 like the
-- adrenaline; CF02 +stamina extra) and the sniper/assault scopes (CG01/CG02, applied by the client from the inventory,
-- FUN_004c2d60).
-- Prices must equal client 22's data/items.bin: the client sends the lease index it shows, and a -1 at that index in
-- item_shop.cost closes the connection (live: DS03 for 3 days). The dump differed for DS03, CF02, CH01 and D101.

UPDATE wres2.item_weapons SET active = 1 WHERE code = 'DS03';
UPDATE wres2.item_extra SET active = 1 WHERE code IN ('CF02', 'CG01', 'CG02');
UPDATE wres2.item_shop SET buyable = 1 WHERE code IN ('DS03', 'CF02', 'CG01', 'CG02');
UPDATE wres2.item_shop SET cost = '3600,-1,7200,8000,-1' WHERE code = 'DS03';
UPDATE wres2.item_shop SET cost = '900,-1,1800,2800,-1' WHERE code = 'CF02';
UPDATE wres2.item_shop SET cost = '-1,-1,7200,11200,-1' WHERE code IN ('CH01', 'D101');
INSERT IGNORE INTO wres2.schema_version (version) VALUES (14);
