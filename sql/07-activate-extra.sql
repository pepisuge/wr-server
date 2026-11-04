-- item_extra rows that were already buyable=1 in item_shop (some since
-- before this session) but still active=0 - an inconsistency found while
-- syncing the real client's items.bin to match what the server actually
-- sells. Doesn't change purchase behavior (shop.js never gates on
-- item_extra.active), just makes our own data internally consistent before
-- the client is told ACTIVE=TRUE for the same codes.
UPDATE item_extra SET active = 1
  WHERE code IN ('CA02', 'CA03', 'CC09', 'CC10', 'CC11', 'CC12', 'CC13', 'CC14', 'CC15', 'CG01', 'CG02', 'CI01');
