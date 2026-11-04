-- Activates item_shop entries for items that are already active in-game
-- (real power/equip-slot data in item_weapons/item_target_info/item_equipment,
-- or already read by inventory.js for CA02/CA03) but were never made buyable.
-- Prices are invented (no client-shipped price survived for these), scaled
-- against the closest comparable item already on sale. See Protocollo
-- WarRock.md, item shop section, for the items.bin cross-check that produced
-- this list and the ones deliberately left out (weapon attachments with no
-- equip path yet: DW01/DW02/DW03/DW04; unimplemented features: CC03/CC04
-- EXP/Dinar boosters). CB01/CB02 were also excluded here at first (thought
-- unimplemented) - see 04-nickchange.sql, they turned out real.

UPDATE item_shop SET buyable = 1, cost = '-1,-1,-1,35000,-1' WHERE code = 'CA02'; -- SLOT_6TH, above CA01's 22000
UPDATE item_shop SET buyable = 1, cost = '-1,-1,-1,50000,-1' WHERE code = 'CA03'; -- SLOT_7TH, above CA02

UPDATE item_shop SET buyable = 1, cost = '-1,4500,-1,14000,-1' WHERE code = 'DJ02'; -- M136 AT4, below DJ03 RPG-7 (power 500 vs 1490)
UPDATE item_shop SET buyable = 1, cost = '-1,5000,-1,16000,-1' WHERE code = 'DJ04'; -- Javelin, same tier as M136 AT4
UPDATE item_shop SET buyable = 1, cost = '-1,3000,-1,9000,-1'  WHERE code = 'DK02'; -- SG, below DK01 Stinger (power 500 vs 1000)
UPDATE item_shop SET buyable = 1, cost = '3500,8000,17000,28000,-1' WHERE code = 'DO03'; -- Flashbang 2, above DO02's Flashbang 1
UPDATE item_shop SET buyable = 1, cost = '-1,-1,2000,3500,-1'  WHERE code = 'DP02'; -- Claymore switch (remote only, no power)
UPDATE item_shop SET buyable = 1, cost = '-1,2500,5000,8000,-1' WHERE code = 'DP03'; -- PDA (engineer tool, power 200)
UPDATE item_shop SET buyable = 1, cost = '-1,-1,8000,15000,-1' WHERE code = 'DP04'; -- Switch C4, above DP01 Claymore (power 6000 vs 1200)
UPDATE item_shop SET buyable = 1, cost = '500,1000,1500,2000,-1' WHERE code = 'DZ01'; -- HA_SUPPLY, same item as DL02, mirrored price
