// Runnable check for the Heal / EnvironmentDamage handlers (needs the game DB running): node tools/test-gamesubs.js
const assert = require('assert');
const { loadConfig } = require('../lib/config');
const { createPool } = require('../lib/db');
const { loadItems } = require('../game/items');
const { HANDLERS, SUB } = require('../game/gamesubs');

(async () => {
  const config = loadConfig ? loadConfig() : require('../lib/config');
  const db = createPool(config.game.db);
  await loadItems(db);
  const mk = (slot, team, o = {}) => ({ slot, team, health: 1000, alive: true, deaths: 0, userId: 1, weapon: 0, ...o });
  const room = (mode = 2) => ({ state: 2, mode, players: new Map() });
  const u = { deaths: 0 };
  const noDb = { query: () => Promise.resolve([]) };

  // Heal: medic kit 2 (DQ02, numeric id 78) on a teammate at 300 hp -> +450
  let r = room(); const medic = mk(0, 0, { weapon: 78 }), mate = mk(1, 0, { health: 300 }), enemy = mk(2, 1, { health: 300 });
  [medic, mate, enemy].forEach((p, i) => r.players.set(i, p));
  let out = HANDLERS[SUB.HEAL](r, medic, [0, 0, 1, 0, 0, 0], u, noDb);
  assert.strictEqual(mate.health, 750); assert.strictEqual(out.payload[3], 750);
  assert.strictEqual(HANDLERS[SUB.HEAL](r, medic, [0, 0, 2, 0, 0, 0], u, noDb), null, 'cannot heal the other team');
  mate.health = 900; HANDLERS[SUB.HEAL](r, medic, [0, 0, 1, 0, 0, 0], u, noDb); assert.strictEqual(mate.health, 1000, 'capped at 1000');
  medic.weapon = 82; mate.health = 100; HANDLERS[SUB.HEAL](r, medic, [0, 0, 1, 0, 0, 0], u, noDb); assert.strictEqual(mate.health, 400, 'adrenaline tops up to 400');
  mate.health = 500; HANDLERS[SUB.HEAL](r, medic, [0, 0, 1, 0, 0, 0], u, noDb); assert.strictEqual(mate.health, 600, 'adrenaline +100 above 400');
  mate.health = 100; HANDLERS[SUB.HEAL](r, medic, [0, 1, 1, 1, 0, 0], u, noDb); assert.strictEqual(mate.health, 500, 'tower +400');

  // EnvironmentDamage: non-lethal keeps the sub type, lethal becomes a Suicide with the slot in [2]
  const p = mk(3, 0, { health: 1000 }); r.players.set(3, p);
  out = HANDLERS[SUB.ENVIRONMENT_DAMAGE](r, p, [0, 0, 1, 0, 0, 250, 0, 0, 0], u, noDb);
  assert.strictEqual(p.health, 750); assert.strictEqual(out.newType, undefined); assert.deepStrictEqual([out.payload[7], out.payload[8]], [250, 750]);
  out = HANDLERS[SUB.ENVIRONMENT_DAMAGE](r, p, [0, 0, 1, 0, 0, 900, 0, 0, 0], u, noDb);
  assert.strictEqual(p.alive, false); assert.strictEqual(p.health, 0); assert.strictEqual(p.deaths, 1);
  assert.strictEqual(out.newType, SUB.SUICIDE); assert.strictEqual(out.payload[2], 3);
  assert.strictEqual(HANDLERS[SUB.ENVIRONMENT_DAMAGE](r, p, [0, 0, 1, 0, 0, 50], u, noDb), null, 'dead players take no damage');
  console.log('OK: heal + environment damage');
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
