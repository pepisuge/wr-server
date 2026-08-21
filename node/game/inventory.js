// Per-user inventory/equipment: loading at authorization, and the shared
// Itemlist/SlotState builders both shop.js (after a purchase) and
// handlers.js (at login) need - ported from Objects/Inventory/Inventory.cs's
// RebuildItemList()/RebuildSlotState().
const { getItem } = require('./items');

const MAX_ITEMS = 32; // Inventory.MAX_ITEMS

const DEFAULT_EQUIPMENT = [
  'DA02,DB01,DF01,DR01,^,^,^,^', // Engineer
  'DA02,DB01,DF01,DQ01,^,^,^,^', // Medic
  'DA02,DB01,DG05,DN01,^,^,^,^', // Sniper
  'DA02,DB01,DC02,DN01,^,^,^,^', // Assault
  'DA02,DB01,DJ01,DL01,^,^,^,^', // Heavy
]; // matches user_equipment's own column defaults

async function loadUserInventory(db, userId) {
  const [rows] = await db.query(
    'SELECT code, startdate, length, retail FROM user_inventory WHERE owner = ? AND expired = 0 AND deleted = 0',
    [userId]
  );
  const inventory = new Map();
  for (const r of rows) {
    inventory.set(r.code.toUpperCase(), { expireDate: Number(r.startdate) + Number(r.length), retail: !!r.retail });
  }
  return inventory;
}

async function loadUserEquipment(db, userId) {
  const [rows] = await db.query('SELECT class1, class2, class3, class4, class5 FROM user_equipment WHERE owner = ?', [
    userId,
  ]);
  const row = rows[0];
  const csvs = row ? [row.class1, row.class2, row.class3, row.class4, row.class5] : DEFAULT_EQUIPMENT;
  return csvs.map((csv) => csv.split(','));
}

function ownsItem(inventory, code, now = Math.floor(Date.now() / 1000)) {
  const entry = inventory.get(String(code || '').toUpperCase());
  if (!entry) return false;
  return entry.retail || entry.expireDate > now;
}

// Codes still actually valid right now - re-checked against expireDate
// rather than trusting the load-time snapshot, since nothing here runs a
// cleanup job to flip `expired` in the DB as leases run out.
function ownedCodes(inventory) {
  const now = Math.floor(Date.now() / 1000);
  return [...inventory.keys()].filter((code) => ownsItem(inventory, code, now));
}

// Itemlist format, ported from RebuildItemList(): "CODE-Type-0-yyMMddHH-Amount"
// per owned item, comma-joined; "^" when empty. Type is 1 for weapon codes
// (start with "D"), 2 otherwise (extras); Amount is always 0 in the
// reference too.
function formatExpiry(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}

function buildItemlist(inventory) {
  const codes = ownedCodes(inventory);
  if (!codes.length) return '^';
  return codes
    .map((code) => {
      const type = code.startsWith('D') ? 1 : 2;
      return `${code}-${type}-0-${formatExpiry(inventory.get(code).expireDate)}-0`;
    })
    .join(',');
}

// SlotState, ported from RebuildSlotState(): 4 T/F flags for slots 5-8.
// Slot 5 is premium-only (not tied to owning CA01, even though CA01=SLOT_5TH
// exists and is buyable in the shop data - the reference itself never reads
// CA01 back for this check, so buying it is a dead purchase there too; not
// "fixed" here, just ported faithfully).
function buildSlotState(user, inventory) {
  const slots = ['F', 'F', 'F', 'F'];
  if (user.premium > 0) slots[0] = 'T';

  const owned = ownedCodes(inventory);
  const has6thWeapon = owned.some((code) => getItem(code)?.canEquip6th);
  if (owned.includes('CA02') || has6thWeapon) slots[1] = 'T';
  if (owned.includes('CA03')) slots[2] = 'T';
  if (owned.includes('CA04')) slots[3] = 'T';

  return slots.join(',');
}

module.exports = {
  MAX_ITEMS,
  loadUserInventory,
  loadUserEquipment,
  ownsItem,
  ownedCodes,
  buildItemlist,
  buildSlotState,
};
