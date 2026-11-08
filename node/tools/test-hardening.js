// Runnable check for the trust-boundary guards, no DB needed: node tools/test-hardening.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { handleUdpPacket } = require('../game/udp-handlers');
const { wrapSocket } = require('../lib/xor-socket');
const { takeSession, pendingSessions } = require('../game/internal-client');
const { createHandlers: createLoginHandlers } = require('../auth/handlers');
const internalHandlers = require('../auth/internal-handlers');
const config = require('../lib/config');

console.log = () => {}; // the handlers are chatty

// UDP: short or garbage datagrams are dropped, never thrown
const udp = { send() {}, address: () => ({ port: 5350 }) };
for (const msg of [Buffer.alloc(0), Buffer.from([1]), Buffer.alloc(15, 0x10), Buffer.from('1010000000000000000000000000002100', 'hex')]) {
  assert.doesNotThrow(() => handleUdpPacket(udp, msg, { address: '1.2.3.4', port: 1 }, 5350));
}

// TCP: a peer that never sends '\n' is cut off instead of growing the buffer forever
const sock = Object.assign(new EventEmitter(), { destroyed: false, write() {}, destroy() { this.destroyed = true; } });
wrapSocket(sock, { send: 0, receive: 0 }, () => {});
sock.emit('data', Buffer.alloc(65 * 1024, 0x41));
assert.ok(sock.destroyed, 'oversized line must destroy the socket');

// Game authorization: only a session Auth announced, for that user, once
pendingSessions.set(7, { userId: 42, username: 'WRUser', displayname: 'WRUser', at: Date.now() });
assert.strictEqual(takeSession(7, 43, 'wruser'), null, 'other userId');
assert.strictEqual(takeSession(8, 42, 'wruser'), null, 'unknown session');
assert.strictEqual(takeSession(7, 42, 'someoneelse'), null, 'other username');
assert.ok(takeSession(7, 42, 'wruser'));
assert.strictEqual(takeSession(7, 42, 'wruser'), null, 'single-use');

// Internal channel: a game server with the wrong key is not registered
const internal = Object.assign(new EventEmitter(), { ended: false, remoteAddress: 'x', end() { this.ended = true; }, sendPacket() { throw new Error('must not reply'); } });
internalHandlers[0x1000](internal, { blocks: ['1', 'wrong-key', 'Evil ', '1.2.3.4', '5340', '0'] });
assert.ok(internal.ended);
const good = Object.assign(new EventEmitter(), { replies: [], end() {}, sendPacket(id, f) { this.replies.push([id, f]); } });
internalHandlers[0x1000](good, { blocks: ['1', config.game.serverKey, 'Spain ', '127.0.0.1', '5340', '0'] });
assert.strictEqual(good.replies[0][1][0], 1);

// PlayerDamage: weapon must be in the loadout, hits are rate-capped, knife needs range
const { HANDLERS, SUB } = require('../game/gamesubs');
const { users } = require('../game/state');
{
  const loadout = ['DA02', 'DB01', 'DF01', 'DR01', '^', '^', '^', '^'];
  const attackerUser = { sessionId: 100, displayname: 'A', equipment: [loadout, loadout, loadout, loadout, loadout], kills: 0, deaths: 0 };
  const victimUser = { sessionId: 101, displayname: 'V', kills: 0, deaths: 0 };
  users.set(100, attackerUser);
  users.set(101, victimUser);
  const mk = (slot, team, sessionId) => ({ slot, team, sessionId, class: 0, health: 1000, alive: true, kills: 0, deaths: 0, userId: sessionId });
  const room = { state: 2, mode: 2, friendlyFire: false, tickets: [30, 30], players: new Map() };
  const att = mk(0, 0, 100);
  const vic = mk(1, 1, 101);
  room.players.set(100, att).set(101, vic);
  const hit = (weapon) => {
    const p = Array(23).fill(0);
    p[2] = 1; p[3] = 1; p[11] = 100 + 1239; p[22] = weapon;
    vic.health = 1000; vic.alive = true;
    return HANDLERS[SUB.PLAYER_DAMAGE](room, att, p, attackerUser, { query: async () => [] });
  };
  att.slot = 3;
  assert.strictEqual(hit('DF01').payload[4], 3, 'attacker slot comes from the server');
  att.slot = 0;
  assert.ok(hit('DF01'), 'own weapon');
  assert.strictEqual(hit('DL01'), null, 'rocket not in the loadout');
  att.hitTimes = [];
  for (let i = 0; i < 20; i++) hit('DF01');
  assert.strictEqual(hit('DF01'), null, '21st hit within a second');
  att.hitTimes = [];
  attackerUser.pos = { x: 0, h: 0, z: 0, t: Date.now() };
  victimUser.pos = { x: 5000, h: 0, z: 0, t: Date.now() };
  assert.strictEqual(hit('DA02'), null, 'knife across the map');
  victimUser.pos = { x: 60, h: 0, z: 0, t: Date.now() };
  assert.ok(hit('DA02'), 'knife in range');
  victimUser.pos.t -= 5000;
  victimUser.pos.x = 5000;
  assert.ok(hit('DA02'), 'stale position: not judged');
  users.delete(100);
  users.delete(101);
}

// Login throttle: 5 failures from one IP lock it out, even with the right password afterwards
(async () => {
  const crypto = require('crypto');
  const row = { id: 1, status: 1, displayname: 'U', passwordsalt: 's', password: crypto.createHash('sha256').update('goodpw' + 's').digest('hex') };
  const login = createLoginHandlers({ query: async () => [[row]] })[0x1100];
  const attempt = async (ip, pw) => {
    const s = { remoteAddress: ip, localAddress: '127.0.0.1', end() {}, sendPacket(id, f) { this.reply = f[0]; } };
    await login(s, { blocks: ['0', '0', 'user', pw] });
    return s.reply;
  };
  assert.strictEqual(await attempt('9.9.9.9', 'goodpw'), 1);
  for (let i = 0; i < 5; i++) assert.strictEqual(await attempt('9.9.9.9', 'bad'), 72020);
  assert.strictEqual(await attempt('9.9.9.9', 'goodpw'), 72020, 'locked out');
  assert.strictEqual(await attempt('8.8.8.8', 'goodpw'), 1, 'other IPs unaffected');
  process.stdout.write('test-hardening: ok\n');
})().catch((err) => {
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
