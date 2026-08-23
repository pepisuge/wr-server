// Item catalog, ported from Game/Managers/ItemManager.cs. Loaded once at
// boot (same pattern as progression.js's loadGameConfig/clan.js's
// loadClans) - items.js/item_shop/item_equipment change rarely enough that
// re-querying per request would be pure waste.
const CLASSES = 5; // Engineer/Medic/Sniper/Assault/Heavy
const SLOTS = 8;

// Inventory.DEFAULT_ITEMS: always equippable for free, no ownership needed -
// the starting loadout every class begins with.
const DEFAULT_ITEMS = new Set(['DA02', 'DB01', 'DF01', 'DG05', 'DC02', 'DJ01', 'DR01', 'DQ01', 'DN01', 'DL01']);

const ITEMS = new Map(); // code -> { code, active, name, isWeapon, buyable, reqLevel, reqPremium, cost[5], power, slots[5][8], canEquip6th }

function parseCsvNumbers(csv) {
  return String(csv || '')
    .split(',')
    .map(Number);
}

function toItem(row) {
  const slots = row.is_weapon
    ? [row.class1, row.class2, row.class3, row.class4, row.class5].map((csv) =>
        String(csv || '')
          .split(',')
          .map((f) => f === '1')
      )
    : null;
  return {
    code: row.code.toUpperCase(),
    active: !!row.active,
    name: row.name,
    isWeapon: !!row.is_weapon,
    buyable: !!row.buyable,
    reqLevel: row.req_level == null ? 1 : Number(row.req_level),
    reqPremium: !!row.req_premium,
    cost: parseCsvNumbers(row.cost),
    power: Number(row.power) || 0,
    slots,
    // Weapon.cs's CanEquip6Th: true if ANY class can equip this weapon in
    // slot index 5 (the 6th slot) - derived from the same matrix, no extra
    // DB column needed.
    canEquip6th: slots ? slots.some((classSlots) => classSlots[5]) : false,
  };
}

async function loadItems(db) {
  const [weapons] = await db.query(`
    SELECT w.code, w.active, w.name, 1 AS is_weapon,
           s.buyable, s.req_level, s.req_premium, s.cost,
           e.class1, e.class2, e.class3, e.class4, e.class5,
           t.power
    FROM item_weapons w
    LEFT JOIN item_shop s ON s.code = w.code
    LEFT JOIN item_equipment e ON e.code = w.code
    LEFT JOIN item_target_info t ON t.code = w.code
  `);
  const [extras] = await db.query(`
    SELECT x.code, x.active, x.name, 0 AS is_weapon,
           s.buyable, s.req_level, s.req_premium, s.cost
    FROM item_extra x
    LEFT JOIN item_shop s ON s.code = x.code
  `);

  ITEMS.clear();
  for (const row of [...weapons, ...extras]) {
    const item = toItem(row);
    ITEMS.set(item.code, item);
  }
  console.log(`Items: loaded ${ITEMS.size} catalog entries.`);
}

function getItem(code) {
  return ITEMS.get(String(code || '').toUpperCase());
}

// Ported from Equipment.cs's `weapon.Active && weapon.CanEquip[class,slot]`
// check - applies uniformly, including to DEFAULT_ITEMS (they're still real
// weapons with real slot constraints, just always-owned).
function isEquipEligible(code, classIdx, slotIdx) {
  const item = getItem(code);
  if (!item || !item.isWeapon || !item.active) return false;
  if (classIdx < 0 || classIdx >= CLASSES || slotIdx < 0 || slotIdx >= SLOTS) return false;
  return item.slots[classIdx][slotIdx];
}

module.exports = { loadItems, getItem, isEquipEligible, DEFAULT_ITEMS, CLASSES, SLOTS };
