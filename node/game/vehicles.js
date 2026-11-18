// Vehicles (Urban Ops / Battle Group), from the reference's VehicleManager (Chapter-1) and ToXiiC's vehicle handlers:
// catalog tables vehicletypes / vehicleseats / vehicleweapons / map_vehicles (wres2), one live copy per match.
// Vehicle ids are the map's own numbering (map_vehicles.VehicleMapID), the same ids the client sends.
const TYPES = new Map(); // code -> { code, health, spawnMs, kind: 1 surface | 2 air | 3 ship }
const SEATS = new Map(); // vehicle code -> [{ id, main, sub, ammo: [mainClip, mainMag, subClip, subMag] }]
const WEAPONS = new Map(); // vehicle weapon / artillery code -> { damage, vs: [personal, surface, air, ship] (percent) }
const BY_MAP = new Map(); // map id -> [{ id, code }]

async function loadVehicles(db) {
  const [[types], [seats], [weapons], [onMaps]] = await Promise.all([
    db.query('SELECT code, health, spawninterval, type FROM vehicletypes'),
    db.query('SELECT vehiclecode, seatid, mainweapon, secondweapon, mainweaponclip, mainweaponmagazine, secondweaponclip, secondweaponmagazine FROM vehicleseats ORDER BY vehiclecode, seatid'),
    db.query('SELECT code, damage, hitbox FROM vehicleweapons'),
    db.query('SELECT MapID, VehicleMapID, VehicleCode FROM map_vehicles'),
  ]);
  TYPES.clear(); SEATS.clear(); WEAPONS.clear(); BY_MAP.clear();
  for (const t of types) TYPES.set(t.code, { code: t.code, health: Number(t.health), spawnMs: Number(t.spawninterval), kind: Number(t.type) });
  const code = (c) => String(c || '').replace(/"/g, '').trim().toUpperCase(); // empty weapons are stored as '""'
  for (const s of seats) {
    if (!SEATS.has(s.vehiclecode)) SEATS.set(s.vehiclecode, []);
    SEATS.get(s.vehiclecode).push({
      id: Number(s.seatid),
      main: code(s.mainweapon),
      sub: code(s.secondweapon),
      ammo: [s.mainweaponclip, s.mainweaponmagazine, s.secondweaponclip, s.secondweaponmagazine].map(Number),
    });
  }
  for (const w of weapons) WEAPONS.set(w.code.toUpperCase(), { damage: Number(w.damage), vs: String(w.hitbox).split(',').map(Number) });
  for (const m of onMaps) {
    if (!TYPES.has(m.VehicleCode)) continue;
    if (!BY_MAP.has(Number(m.MapID))) BY_MAP.set(Number(m.MapID), []);
    BY_MAP.get(Number(m.MapID)).push({ id: Number(m.VehicleMapID), code: m.VehicleCode });
  }
  console.log(`Vehicles: ${TYPES.size} types, ${WEAPONS.size} weapons, vehicles on ${BY_MAP.size} maps.`);
}

// A fresh set for a match: id -> vehicle. Seats hold the player object sitting there (or null) and its ammo.
function createRoomVehicles(mapId) {
  const out = new Map();
  for (const { id, code } of BY_MAP.get(Number(mapId)) || []) {
    const t = TYPES.get(code);
    const seats = (SEATS.get(code) || []).map((s) => ({ ...s, ammo: [...s.ammo], player: null }));
    out.set(id, { id, code, kind: t.kind, maxHealth: t.health, health: t.health, spawnMs: t.spawnMs, seats, respawnTimer: null });
  }
  return out;
}

function resetVehicle(v) {
  v.health = v.maxHealth;
  for (const s of v.seats) s.player = null;
}

// A seat is taken only while its player is still in the room, alive and sitting in this vehicle (deaths and room
// leaves never have to remember to free it).
function occupant(room, v, seat) {
  const p = seat.player;
  return p && p.alive && room.players.get(p.sessionId) === p && p.vehicle?.id === v.id ? p : null;
}

function occupants(room, v) {
  return v.seats.map((s) => occupant(room, v, s)).filter(Boolean);
}

// The team of whoever is inside; null when empty (anyone may enter, anyone may shoot it).
function vehicleTeam(room, v) {
  return occupants(room, v)[0]?.team ?? null;
}

// Damage percent of a weapon against a target kind (0 personal, 1 surface, 2 air, 3 ship) and the client's radius
// percent: Chapter-1 DamageCalculator = power x efficiency% x radius%.
function damageOf(power, efficiency, radius) {
  return Math.round((power * efficiency * radius) / 10000);
}

// Radius percent of an explosion hit (payload[10] = 1, payload[11] = 0-100); a direct hit counts in full.
function radiusOf(payload) {
  const r = Number(payload[11]);
  return Number(payload[10]) === 1 && r >= 0 && r <= 100 ? r : 100;
}

const getWeapon = (code) => WEAPONS.get(String(code).toUpperCase());

module.exports = {
  loadVehicles, createRoomVehicles, resetVehicle, occupant, occupants, vehicleTeam, damageOf, radiusOf, getWeapon,
};
