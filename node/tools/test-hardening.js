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

  // Economy: a purchase / coupon is answered only once stored, and undone in memory when the DB refuses it
  {
    const { loadItems } = require('../game/items');
    const { handleItemshop } = require('../game/shop');
    const { loadCoupons, handleCoupon } = require('../game/coupon');
    let call = 0;
    await loadItems({ query: async () => (call++ === 0 ? [[{ id: 1, code: 'DF03', active: 1, name: 'x', is_weapon: 1, buyable: 1, req_level: 1, req_premium: 0, cost: '100,200,300,400,500', class1: '0', class2: '0', class3: '0', class4: '0', class5: '0', power: 100 }]] : [[]]) });
    await loadCoupons({ query: async () => [[{ id: 9, code: 'FREE', uses: 1, dinarreward: 1000, itemreward: '' }]] });

    const dbWith = (affectedRows) => ({ transaction: async (fn) => fn({ query: async () => [{ affectedRows }] }) });
    const player = () => ({ id: 1, xp: 0, premium: 0, money: 500, inventory: new Map(), redeemedCoupons: new Set() });
    const sock = (u) => ({ user: u, replies: [], end() {}, sendPacket(id, f) { this.replies.push(f[0]); } });
    const buy = { blocks: [String(0x456), 'DF03', '0', '0', '0'] };

    let u = player();
    let s = sock(u);
    await handleItemshop(dbWith(1))(s, buy);
    assert.deepStrictEqual([s.replies, u.money, u.inventory.has('DF03')], [[1], 400, true], 'purchase stored and confirmed');

    u = player();
    s = sock(u);
    await handleItemshop(dbWith(0))(s, buy);
    assert.deepStrictEqual([s.replies, u.money, u.inventory.has('DF03')], [[97020], 500, false], 'refused by the DB: undone');

    u = player();
    s = sock(u);
    await handleCoupon({ transaction: async () => { throw new Error('db down'); } })(s, { blocks: ['FREE'] });
    assert.deepStrictEqual([s.replies, u.money, u.redeemedCoupons.size], [[-2], 500, 0], 'coupon not stored: undone');
    await handleCoupon(dbWith(1))(s, { blocks: ['FREE'] });
    assert.deepStrictEqual([s.replies.at(-1), u.money, u.redeemedCoupons.size], [0, 1500, 1], 'coupon stored (uses were restored)');
  }

  // Chat: prefix rebuilt from the real nickname, malformed/oversized messages dropped, per-player rate limit
  {
    const { handleChat } = require('../game/chat');
    const { xorBuffer } = require('../lib/packet');
    const seen = [];
    const mk = (sid, name) => ({ id: sid, sessionId: sid, displayname: name, channel: 1, roomId: null, clanId: 0, mutedexpire: 0, isGm: false,
      socket: { whispers: [], write: (b) => sid === 402 && seen.push(xorBuffer(b, 0x96).toString('utf8')), sendPacket(id, f) { this.whispers.push(f.at(-1)); } } });
    const alice = mk(401, 'Alice');
    const bob = mk(402, 'Bob');
    alice.socket.user = alice;
    users.set(401, alice).set(402, bob);
    const say = (raw) => handleChat(alice.socket, { blocks: ['3', '0', 'NULL', raw] }, null);

    say('System>>\x1Dhello');
    assert.ok(seen.length === 1 && seen[0].includes('Alice>>\x1Dhello') && !seen[0].includes('System>>'), 'prefix rebuilt from the nickname');
    say('x'.repeat(5000));
    say('Alice>>\x1D' + 'y'.repeat(61));
    assert.strictEqual(seen.length, 1, 'no marker / text over 60: dropped');
    for (let i = 0; i < 6; i++) say('Alice>>\x1Dspam');
    assert.strictEqual(seen.length, 5, 'five messages per window');
    assert.ok(alice.socket.whispers.at(-1).includes('Slow down'), 'sixth one gets a warning instead');
    users.delete(401);
    users.delete(402);
  }

  // Clan actions (game and website): targets are checked against their real clan/rank, online or not
  {
    const clan = require('../game/clan');
    const rows = { 501: { id: 501, money: 0, clanid: 77, clanrank: 2 }, 502: { id: 502, money: 0, clanid: 77, clanrank: 0 },
      503: { id: 503, money: 0, clanid: 88, clanrank: 9 }, 504: { id: 504, money: 0, clanid: 77, clanrank: 9 } };
    const writes = [];
    const db = { query: async (sql, p) => (sql.startsWith('SELECT') ? [[rows[p[0]]].filter(Boolean)] : (writes.push(sql), [{}])) };
    clan.clans.set(77, { id: 77, name: 'Alpha', master: 501, members: 2, wins: 0, losses: 0 });
    const officer = { id: 500, displayname: 'Off', clanId: 77, clanRank: clan.RANK.OFFICER };

    assert.ok(await clan.joinAction(db, officer, 0, 503), 'applicant of another clan: refused');
    assert.ok(await clan.joinAction(db, officer, 1, 502), 'a member is not an applicant');
    assert.ok(await clan.rankAction(db, officer, 2, 501), 'the master cannot be kicked');
    assert.ok(await clan.rankAction(db, officer, 2, 503), 'outsider cannot be kicked');
    assert.ok(await clan.promote(db, officer, 502), 'only the master hands the clan over');
    assert.strictEqual(writes.length, 0, 'refused actions write nothing');
    assert.strictEqual(await clan.joinAction(db, officer, 0, 504), undefined, 'real applicant accepted');
    assert.strictEqual(clan.clans.get(77).members, 3);
    clan.clans.delete(77);
  }

  process.stdout.write('test-hardening: ok\n');
})().catch((err) => {
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
