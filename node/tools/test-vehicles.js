// node tools/test-vehicles.js - vehicles without a DB: enter, change seat, gunner hit, artillery guard, destroy, respawn.
const assert = require('assert');
const V = require('../game/vehicles');
const { loadItems } = require('../game/items');
const { HANDLERS, SUB } = require('../game/gamesubs');

const rows = {
  item_weapons: [{ id: 1, code: 'DJ01', active: 1, name: 'RPG', is_weapon: 1, power: 1200, surface: '100,100,100', air: '60,50,35', ship: '80,20,20' }],
  item_extra: [],
  vehicletypes: [{ code: 'ED01', health: 3500, spawninterval: 50, type: 1 }],
  vehicleseats: [
    { vehiclecode: 'ED01', seatid: 0, mainweapon: '""', secondweapon: '""', mainweaponclip: 0, mainweaponmagazine: 0, secondweaponclip: 0, secondweaponmagazine: 0 },
    { vehiclecode: 'ED01', seatid: 1, mainweapon: 'FB01', secondweapon: '""', mainweaponclip: 30000, mainweaponmagazine: 0, secondweaponclip: 0, secondweaponmagazine: 0 },
  ],
  vehicleweapons: [{ code: 'FB01', damage: 650, hitbox: '55,17,8,10' }],
  map_vehicles: [{ MapID: 7, VehicleMapID: 3, VehicleCode: 'ED01' }],
};
const db = { query: async (sql) => [rows[Object.keys(rows).find((t) => sql.includes(`FROM ${t}`))] || {}] };

(async () => {
  await loadItems(db);
  await V.loadVehicles(db);
  const mk = (slot, team, sessionId) => ({ slot, team, sessionId, alive: true, health: 1000, kills: 0, deaths: 0, class: 3, userId: slot });
  const a = mk(0, 0, 'a'), b = mk(1, 1, 'b');
  const room = { id: 1, state: 2, mode: 2, channel: 2, map: 7, players: new Map([['a', a], ['b', b]]), tickets: [30, 30] };
  room.vehicles = V.createRoomVehicles(7);
  const user = (s) => ({ sessionId: s, kills: 0, deaths: 0, inventory: new Map(), equipment: { 3: ['DJ01'] } });
  const ua = user('a'), ub = user('b');
  const run = (sub, p, payload, u) => HANDLERS[sub](room, p, payload, u, db);
  const pkt = (src, target, named) => Object.assign(Array(23).fill(0), { 2: src, 3: target, 22: named });

  let r = run(SUB.ENTER_VEHICLE, b, [0, 0, 3, 0, 0, 0, 0, 0, 0, 0], ub);
  assert.deepStrictEqual(r.payload.slice(2, 6), [3, 0, 3500, 3500]);
  assert.strictEqual(run(SUB.ENTER_VEHICLE, a, [0, 0, 3], ua), null, 'enemy team cannot board');
  r = run(SUB.CHANGE_SEAT, b, [0, 0, 3, 1, 0, 0, 0, 0], ub);
  assert.deepStrictEqual(r.payload.slice(3, 6), [1, 0, 30000]);

  // gunner (seat 1, FB01) hits a player: 650 x personal 55% = 358
  r = run(SUB.PLAYER_DAMAGE, b, pkt(0, 0, 'ED01'), ub);
  assert.strictEqual(r.payload[12], 1000 - 358);
  // on foot, no DX01: a "vehicle/artillery" hit is refused
  assert.strictEqual(run(SUB.OBJECT_DAMAGE, a, pkt(0, 3, 'FB01'), ua), null);

  // RPG on the vehicle: 1200 x surface 100%
  r = run(SUB.OBJECT_DAMAGE, a, pkt(1, 3, 'DJ01'), ua);
  assert.deepStrictEqual(r.payload.slice(12, 14), [2300, 3500]);
  r = run(SUB.OBJECT_DAMAGE, a, pkt(1, 3, 'DJ01'), ua);
  r = run(SUB.OBJECT_DAMAGE, a, pkt(1, 3, 'DJ01'), ua); // destroyed
  const v = room.vehicles.get(3);
  assert.strictEqual(v.health, 0);
  assert.strictEqual(b.alive, false, 'occupant killed');
  assert.strictEqual(a.kills, 1);
  await new Promise((ok) => setTimeout(ok, 80));
  assert.strictEqual(v.health, 3500, 'respawned after its interval');
  assert.ok(v.seats.every((s) => !s.player));
  console.log('test-vehicles: ok');
})();
