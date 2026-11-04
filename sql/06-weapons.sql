-- Weapons that are real (active in item_weapons, real item_target_info
-- power) but were never priced in item_shop. See Protocollo WarRock.md
-- for the reasoning behind each one.

-- D001 (Barrel, power 650) sits in the 8th weapon slot (item_equipment's
-- 8th column, all classes) alongside D501/D502 (gold-skin weapons) - that
-- whole slot is already real and monetized (CA04 SLOT_8TH is buyable,
-- 7000/15000/22000). D001 was the one weapon in it missing a price.
-- Calibrated against D902/DT02 (power 600) and DG06 (power 700), both
-- already on sale in that range.
UPDATE item_shop SET buyable = 1, cost = '4000,6500,11000,18000,-1' WHERE code = 'D001';

-- DW01-04 looked like weapon attachments with no way to equip them (all-zero
-- item_equipment matrix) - but their code prefix (2nd letter W) matches
-- items.bin's own <WEAPON> type table's "AllClass" category, the exact same
-- category as DS01/DS02/DS03/DS05/DS10 ("AllClass_Paid", 1st letter S) -
-- which all already sit in the real, working 6th-slot matrix
-- (0,0,0,0,0,1,0,0 for every class, gated by CA02/SLOT_6TH, already on sale
-- since 03-activate-item-shop.sql). The all-zero matrix here reads as a data
-- gap in the original seed, not a missing subsystem - reusing the real
-- sibling pattern instead of inventing one. Not yet confirmed against a live
-- capture that DW-prefixed items actually use slot 6 specifically (see the
-- guide) - matrix and prices are the best-supported inference available,
-- not a certainty.
UPDATE item_equipment SET class1 = '0,0,0,0,0,1,0,0', class2 = '0,0,0,0,0,1,0,0',
  class3 = '0,0,0,0,0,1,0,0', class4 = '0,0,0,0,0,1,0,0', class5 = '0,0,0,0,0,1,0,0'
  WHERE code IN ('DW01', 'DW02', 'DW03', 'DW04');

UPDATE item_shop SET buyable = 1, cost = '3500,-1,7000,10000,-1' WHERE code = 'DW01'; -- K203, power 1000 - tier of DS01/DS03
UPDATE item_shop SET buyable = 1, cost = '900,-1,1800,2800,-1'   WHERE code = 'DW02'; -- Telescope, power 0 - mirrors DS02 Parachute exactly (same utility tier)
UPDATE item_shop SET buyable = 1, cost = '1000,-1,2000,3200,-1' WHERE code = 'DW03'; -- Silencer, power 0 - just above DW02
UPDATE item_shop SET buyable = 1, cost = '1200,-1,2400,3800,-1' WHERE code = 'DW04'; -- Nippers, power 700 - between DW01 and the DS02/03 utility tier
