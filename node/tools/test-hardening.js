// Runnable check for the trust-boundary guards, no DB needed: node tools/test-hardening.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { handleUdpPacket } = require('../game/udp-handlers');
const { wrapSocket, admitConnection, MAX_PACKETS_PER_SEC } = require('../lib/xor-socket');
const { takeSession, pendingSessions } = require('../game/internal-client');
const { createHandlers: createLoginHandlers, hashPassword } = require('../auth/handlers');
const internalHandlers = require('../auth/internal-handlers');
const config = require('../lib/config');

console.log = () => {}; // the handlers are chatty

// UDP: short or garbage datagrams are dropped, never thrown
const udp = { send() {}, address: () => ({ port: 5350 }) };
for (const msg of [Buffer.alloc(0), Buffer.from([1]), Buffer.alloc(15, 0x10), Buffer.from('1010000000000000000000000000002100', 'hex')]) {
  assert.doesNotThrow(() => handleUdpPacket(udp, msg, { address: '1.2.3.4', port: 1 }, 5350));
}

// UDP relay: a handshake must come from the player's TCP IP, frames from its handshake endpoint
{
  const { users: u2, getChannel } = require('../game/state');
  const sent = [];
  const sock = { send: (m, port, address) => sent.push(`${address}:${port}`), address: () => ({ port: 5350 }) };
  const mkUser = (sid, ip) => ({ sessionId: sid, channel: 1, roomId: 7, socket: { remoteAddress: `::ffff:${ip}` } });
  const a = mkUser(201, '10.0.0.1');
  const b = mkUser(202, '10.0.0.2');
  u2.set(201, a).set(202, b);
  getChannel(1).rooms.set(7, { state: 2, players: new Map() });
  const handshake = (sid) => { const m = Buffer.alloc(65); m.writeUInt16BE(0x1010, 0); m.writeUInt16BE(sid, 4); m[14] = 0x21; return m; };
  const frame = (sid, target) => { const m = Buffer.alloc(126); m.writeUInt16BE(0x1010, 0); m.writeUInt16BE(sid, 4); m.writeUInt16BE(7, 6); m.writeUInt16BE(target, 22); m[14] = 0x31; return m; };

  handleUdpPacket(sock, handshake(201), { address: '6.6.6.6', port: 9 }, 5350);
  assert.strictEqual(a.udpEndpoint, undefined, 'handshake from another IP refused');
  handleUdpPacket(sock, handshake(201), { address: '10.0.0.1', port: 4000 }, 5350);
  handleUdpPacket(sock, handshake(202), { address: '10.0.0.2', port: 5000 }, 5350);
  assert.deepStrictEqual(a.udpEndpoint, { address: '10.0.0.1', port: 4000 });

  sent.length = 0;
  handleUdpPacket(sock, frame(201, 202), { address: '10.0.0.1', port: 4000 }, 5350);
  assert.deepStrictEqual(sent, ['10.0.0.2:5000'], 'legit frame relayed');
  assert.ok(a.pos, 'position recorded');
  sent.length = 0;
  delete a.pos;
  handleUdpPacket(sock, frame(201, 202), { address: '6.6.6.6', port: 4000 }, 5350);
  handleUdpPacket(sock, frame(201, 202), { address: '10.0.0.1', port: 4001 }, 5350);
  assert.deepStrictEqual(sent, [], 'frames as another player dropped');
  assert.strictEqual(a.pos, undefined, 'spoofed frame does not move the position');
  u2.delete(201);
  u2.delete(202);
  getChannel(1).rooms.delete(7);
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

  // Password storage: a legacy SHA-256 account logs in and is upgraded to scrypt; the scrypt hash then works
  {
    const queries = [];
    const legacy = { ...row };
    const db = { query: async (sql, args) => (queries.push([sql, args]), [[legacy]]) };
    const s = { remoteAddress: '5.5.5.5', localAddress: '127.0.0.1', end() {}, sendPacket(id, f) { this.reply = f[0]; } };
    await createLoginHandlers(db)[0x1100](s, { blocks: ['0', '0', 'user', 'goodpw'] });
    assert.strictEqual(s.reply, 1, 'legacy hash still accepted');
    await new Promise((r) => setTimeout(r, 300)); // upgrade is fire-and-forget
    const upd = queries.find(([sql]) => sql.startsWith('UPDATE users SET password'));
    assert.ok(upd && upd[1][1].startsWith('$') && upd[1][1].length === 10, 'upgraded to a scrypt salt');
    assert.strictEqual(upd[1][0], await hashPassword('goodpw', upd[1][1]));
    const upgraded = { ...row, password: upd[1][0], passwordsalt: upd[1][1] };
    const login2 = createLoginHandlers({ query: async () => [[upgraded]] })[0x1100];
    const t = { remoteAddress: '5.5.5.6', localAddress: '127.0.0.1', end() {}, sendPacket(id, f) { this.reply = f[0]; } };
    await login2(t, { blocks: ['0', '0', 'user', 'goodpw'] });
    assert.strictEqual(t.reply, 1, 'scrypt hash accepted');
    await login2(t, { blocks: ['0', '0', 'user', 'wrongpw'] });
    assert.strictEqual(t.reply, 72020, 'scrypt hash rejects a wrong password');
  }

  // Duplicate login race: two sessions of the same account authorizing at the same time -> only one gets in
  {
    const { createHandlers: createGameHandlers } = require('../game/handlers');
    const anyRow = { xp: 0, money: 0, premium: 0, premium_expiredate: 0, kills: 0, deaths: 0, clanid: -1, clanrank: 0, is_gm: 0, mutedexpire: 0,
      code: 'DA02', startdate: 0, length: 0, retail: 0, class1: 'DA02', class2: 'DA02', class3: 'DA02', class4: 'DA02', class5: 'DA02', coupon_id: 1 };
    const slowDb = { query: () => new Promise((r) => setTimeout(() => r([[anyRow]]), 30)) };
    const auth = createGameHandlers(slowDb)[0x6200];
    for (const sid of [301, 302]) pendingSessions.set(sid, { userId: 77, username: 'racer', displayname: 'Racer', at: Date.now() });
    const sock = () => ({ destroyed: false, end() {}, on() {}, write() {}, sendPacket(id, f) { this.reply = f[0]; } });
    const s1 = sock();
    const s2 = sock();
    await Promise.all([auth(s1, { blocks: ['77', '0', 'racer', 'x', '301'] }), auth(s2, { blocks: ['77', '0', 'racer', 'x', '302'] })]);
    assert.deepStrictEqual([s1.reply, s2.reply].sort(), [1, 92040], 'exactly one login wins');
    users.delete(301);
    users.delete(302);
  }

  // Client-facing limits: packets per second per connection, connections per IP
  {
    const flood = Object.assign(new EventEmitter(), { destroyed: false, write() {}, destroy() { this.destroyed = true; } });
    let handled = 0;
    wrapSocket(flood, { send: 0, receive: 0 }, () => handled++, MAX_PACKETS_PER_SEC);
    flood.emit('data', Buffer.from('1 2 x \n'.repeat(MAX_PACKETS_PER_SEC + 1)));
    assert.ok(flood.destroyed, 'packet flood disconnected');
    assert.strictEqual(handled, MAX_PACKETS_PER_SEC);

    const conn = () => Object.assign(new EventEmitter(), { remoteAddress: '7.7.7.7', destroyed: false, destroy() { this.destroyed = true; } });
    const open = Array.from({ length: 10 }, conn);
    assert.ok(open.every((c) => admitConnection(c)), '10 connections from one IP allowed');
    const extra = conn();
    assert.strictEqual(admitConnection(extra), false);
    assert.ok(extra.destroyed, '11th connection refused');
    open[0].emit('close');
    assert.ok(admitConnection(conn()), 'a slot frees up when one closes');
  }

  // Shutdown: pool.close() waits for queries still in flight instead of failing them
  {
    const { createPool } = require('../lib/db');
    const pool = createPool({ host: '127.0.0.1', port: 1, user: 'x', connectTimeout: 2000 });
    let settled = false;
    pool.query('SELECT 1').catch(() => { settled = true; });
    await pool.close();
    assert.ok(settled, 'close waited for the in-flight query');
  }

  process.stdout.write('test-hardening: ok\n');
})().catch((err) => {
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
