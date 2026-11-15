// Runnable check for the Heal / EnvironmentDamage handlers (needs the game DB running): node tools/test-gamesubs.js
const assert = require('assert');
const { loadConfig } = require('../lib/config');
const { createPool } = require('../lib/db');
const { loadItems } = require('../game/items');
const { HANDLERS, SUB, bleed } = require('../game/gamesubs');
const { users } = require('../game/state');

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
  // Ground items: place a land mine (owned), step on it, medic box heals, unowned items are refused
  const inv = new Map([['DU02', { expireDate: 9e9, retail: false }], ['DV01', { expireDate: 9e9, retail: false }], ['DX01', { expireDate: 9e9, retail: false }]]);
  const gu = { ...u, inventory: inv }; const g = mk(5, 0); r.players.set(5, g);
  const place = (code) => HANDLERS[SUB.PLACE_ITEM](r, g, [...Array(27).fill(0), code], gu, noDb);
  out = place('DU02'); assert.strictEqual(out.payload[4], 0);
  assert.strictEqual(place('DU01'), null, 'item not owned');
  assert.strictEqual(HANDLERS[SUB.USE_ITEM](r, g, [0, 0, 0, 0, 0, 0, 0, ...Array(15).fill(0), 'DU02'], gu, noDb), null, 'own mine');
  assert.strictEqual(HANDLERS[SUB.USE_ITEM](r, mate, [0, 0, 0, 0, 0, 0, 0, ...Array(15).fill(0), 'DU02'], gu, noDb), null, 'teammate');
  mate.alive = true; enemy.alive = true; enemy.health = 1000;
  out = HANDLERS[SUB.USE_ITEM](r, enemy, [0, 0, 0, 0, 0, 0, 0, ...Array(15).fill(0), 'DU02'], gu, noDb);
  assert.strictEqual(enemy.health, 700); assert.strictEqual(out.payload[6], 700);
  g.health = 700;
  assert.strictEqual(HANDLERS[SUB.USE_ITEM](r, enemy, [0, 0, 0, 0, 0, 0, 0, ...Array(15).fill(0), 'DU02'], gu, noDb).selfTarget, true, 'already used: answered to the sender only');
  const box = place('DV01') || (inv.set('DV01', { expireDate: 9e9 }), place('DV01')); assert.strictEqual(box.payload[4], 1, 'ids are stable, not list indices');
  HANDLERS[SUB.USE_ITEM](r, g, [0, 0, 0, 0, 1, 0, 0, ...Array(15).fill(0), 'DV01'], gu, noDb); assert.strictEqual(g.health, 1000);
  assert.strictEqual(HANDLERS[SUB.ARTILLERY](r, g, [0, 0, 0, 0], gu, noDb).payload[3], 1);
  inv.delete('DX01'); assert.strictEqual(HANDLERS[SUB.ARTILLERY](r, g, [0, 0, 0, 0], gu, noDb), null);
  // Flash mine: like the land mine, it never goes off for its owner or a teammate (it blinded its own planter, live).
  inv.set('DS05', { expireDate: 9e9, retail: false });
  const flashId = place('DS05').payload[4];
  const stepFlash = (who) => HANDLERS[SUB.USE_ITEM](r, who, [0, 0, 0, 0, flashId, 0, 0, ...Array(15).fill(0), 'DS05'], gu, noDb);
  assert.strictEqual(stepFlash(g), null, 'own flash mine');
  assert.strictEqual(stepFlash(mate), null, 'teammate');
  assert.strictEqual(stepFlash(enemy).payload[3], enemy.slot, 'an enemy is flashed');

  // Bleeding: under 300 HP, -5 every 10 s, none with CH01, bleeding out is a death.
  const br = room(); br.id = 3; br.channel = 1;
  const bled = mk(0, 0, { health: 250, sessionId: 901 }), banded = mk(1, 0, { health: 250, sessionId: 902 }), fine = mk(2, 1, { health: 300, sessionId: 903 });
  [bled, banded, fine].forEach((p) => br.players.set(p.sessionId, p));
  users.set(901, { deaths: 0, inventory: new Map() });
  users.set(902, { deaths: 0, inventory: new Map([['CH01', { expireDate: 9e9, retail: false }]]) });
  users.set(903, { deaths: 0, inventory: new Map() });
  for (let i = 0; i < 9; i++) bleed(br, noDb);
  assert.strictEqual(bled.health, 250, 'nothing before 10 s');
  bleed(br, noDb);
  assert.deepStrictEqual([bled.health, banded.health, fine.health], [245, 250, 300]);
  bled.health = 4;
  for (let i = 0; i < 10; i++) bleed(br, noDb);
  assert.deepStrictEqual([bled.alive, bled.health, bled.deaths], [false, 0, 1], 'bled out');
  console.log('OK: heal + environment damage + ground items + artillery + bleeding');
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
