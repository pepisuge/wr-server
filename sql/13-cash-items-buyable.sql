-- CB01 (nickname change) and CB03 (kill/death reset) for dinar. sql/04 assumed CB01 was already buyable; the
-- reference dump has buyable = 0 for both, so the shop answered 97020 "item cannot be bought" (live, client 22).
-- Prices are the dump's own single cost ('9800', '33000'): index 0, a 3-day lease until the item is used.

UPDATE wres2.item_extra SET active = 1 WHERE code IN ('CB01', 'CB03');
UPDATE wres2.item_shop SET buyable = 1 WHERE code IN ('CB01', 'CB03');
INSERT IGNORE INTO wres2.schema_version (version) VALUES (13);
