// Ported from Game/Handlers/Equipment.cs - real validation now (item
// exists, fits the class/slot per item_equipment, is actually owned or a
// free default weapon), replacing the old placeholder that accepted any
// 4-letter code blindly and never persisted anything.
const { isEquipEligible, DEFAULT_ITEMS } = require('./items');
const { ownsItem } = require('./inventory');

const EQUIPMENT = 0x7512;
const ALREADY_EQUIPPED = 97090; // Packets/Equipment.cs's ErrorCode.AlreadyEquipped (0x17B42)

function persistEquipment(db, u) {
  const [c1, c2, c3, c4, c5] = u.equipment.map((slots) => slots.join(','));
  db.query(
    `INSERT INTO user_equipment (owner, class1, class2, class3, class4, class5) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE class1=VALUES(class1), class2=VALUES(class2), class3=VALUES(class3), class4=VALUES(class4), class5=VALUES(class5)`,
    [u.id, c1, c2, c3, c4, c5]
  ).catch((err) => console.error('equipment: failed to persist:', err.message));
}

function handleEquipment(db) {
  return (socket, pkt) => {
    const u = socket.user;
    if (!u) return;

    const targetClass = Number(pkt.blocks[1]);
    if (!(targetClass >= 0 && targetClass < 5)) return;

    const equipItem = Number(pkt.blocks[0]) === 0;

    if (!equipItem) {
      const targetSlot = Number(pkt.blocks[3]);
      if (!(targetSlot >= 0 && targetSlot < 8)) return;
      u.equipment[targetClass][targetSlot] = '^';
      persistEquipment(db, u);
      return socket.sendPacket(EQUIPMENT, [1, targetClass, u.equipment[targetClass].join(',')]);
    }

    const weaponCode = (pkt.blocks[4] || '').toUpperCase();
    const targetSlot = Number(pkt.blocks[5]);
    if (weaponCode.length !== 4 || !(targetSlot >= 0 && targetSlot < 8)) return;

    // Ported as: a GM (our stand-in for the reference's AccessLevel>3) only
    // skips the class/slot-fit check, same scope as the reference - not
    // ownership, that's still enforced either way.
    if (!u.isGm && !isEquipEligible(weaponCode, targetClass, targetSlot)) return socket.end();

    const owned = DEFAULT_ITEMS.has(weaponCode) || ownsItem(u.inventory, weaponCode);
    if (!owned) return socket.end(); // reference: not a default item and not owned -> treated as scripting/cheat

    if (u.equipment[targetClass][targetSlot] === weaponCode) {
      return socket.sendPacket(EQUIPMENT, [ALREADY_EQUIPPED]);
    }

    // An item only occupies one slot at a time per class - clear its old
    // spot (if any) before placing it in the new one.
    const currentSlot = u.equipment[targetClass].indexOf(weaponCode);
    if (currentSlot !== -1) u.equipment[targetClass][currentSlot] = '^';
    u.equipment[targetClass][targetSlot] = weaponCode;

    persistEquipment(db, u);
    socket.sendPacket(EQUIPMENT, [1, targetClass, u.equipment[targetClass].join(',')]);
  };
}

module.exports = { handleEquipment, EQUIPMENT };
