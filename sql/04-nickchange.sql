-- CB01 (account nickname change) and CB02 (clan rename) looked unimplemented
-- at first (same trap as the GM commands, CLAUDE.md) - Chapter-1-Server never
-- wires them, but ToXiiC-Core's CashItemBuy.cs (CB01, OnItemUse) and Clan.cs
-- (CB02, NickChange subtype) do, cabled to real DB mutations. Ported in
-- node/game/shop.js and node/game/clan.js. See docs/protocol/economy.md.

UPDATE item_extra SET active = 1 WHERE code = 'CB01'; -- item_shop.buyable was already 1 here, cost '9800' unchanged

UPDATE item_extra SET active = 1 WHERE code = 'CB02';
UPDATE item_shop SET buyable = 1, cost = '50000' WHERE code = 'CB02'; -- invented, above CB01's 9800: renames a whole clan, not just one player
