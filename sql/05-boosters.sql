-- CC03 (UP_EXP) / CC04 (UP_DINAR): confirmed dead in both C# references (no
-- code applies the multiplier anywhere - see Protocollo WarRock.md 9.3bis).
-- Self-designed from here on, not a port: node/game/progression.js now
-- applies a +30% XP/Dinar rate at match-end while the item is owned, reusing
-- ToXiiC-Core's own unused gameserver.xml EXPBonus/DinarBonus=0.3 values.
-- Priced above the cosmetic CC01/CC02 QoL items (they affect progression
-- itself, not just display) and paired identically since they're symmetric.

UPDATE item_extra SET active = 1 WHERE code IN ('CC03', 'CC04');
UPDATE item_shop SET buyable = 1, cost = '-1,5000,9000,15000,-1' WHERE code IN ('CC03', 'CC04');
