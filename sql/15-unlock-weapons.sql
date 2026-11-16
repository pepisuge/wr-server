-- Weapons that client 22 ships disabled but with models and textures (#60), enabled by the client mod's items.bin.
-- Only the MAC10 has a price in the client; the others are BUYTYPE 9 ("not for sale") there, so they stay out of the
-- shop (a price the client does not show would never match) and are handed out with /giveitem or the website.
-- The DB rows (item_weapons, item_equipment, item_target_info) already exist in the reference dump.

UPDATE wres2.item_weapons SET active = 1 WHERE code IN ('DF09', 'DJ04', 'DP03', 'DP04', 'DW04', 'DQ02', 'DQ03', 'DO03');
UPDATE wres2.item_shop SET buyable = 1, cost = '2300,3900,7100,12800,1250' WHERE code = 'DF09';
UPDATE wres2.item_shop SET buyable = 0 WHERE code IN ('DJ04', 'DP03', 'DP04', 'DW04', 'DQ02', 'DQ03', 'DO03');
-- Javelin: the client's TARGET_INFO personal is 90,80,70 (the dump had 100,80,70).
UPDATE wres2.item_target_info SET personal = '90,80,70' WHERE code = 'DJ04';
INSERT IGNORE INTO wres2.schema_version (version) VALUES (15);
