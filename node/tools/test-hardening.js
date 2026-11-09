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

    // ranks are the master's: an officer can kick a plain member, nothing else
    rows[505] = { id: 505, money: 0, clanid: 77, clanrank: 1 };
    assert.ok(await clan.rankAction(db, officer, 0, 502), 'officer cannot promote');
    assert.ok(await clan.rankAction(db, officer, 1, 505), 'officer cannot demote an officer');
    assert.ok(await clan.rankAction(db, officer, 2, 505), 'officer cannot kick an officer');
    assert.strictEqual(await clan.rankAction(db, officer, 2, 502), undefined, 'officer kicks a member');
    const master = { id: 501, displayname: 'Boss', clanId: 77, clanRank: clan.RANK.MASTER };
    assert.strictEqual(await clan.rankAction(db, master, 1, 505), undefined, 'master demotes an officer');
    clan.clans.delete(77);

    // clan war result: only with both clans present at the start; tickets decide TDM, equal = draw
    const { settleWar } = require('../game/roundtimer');
    const mk = (id) => ({ id, name: `c${id}`, wins: 0, losses: 0, draws: 0 });
    clan.clans.set(81, mk(81)).set(82, mk(82));
    const war = (warTeams, teams, tickets) => settleWar({ isClanWar: 1, clan1: 81, clan2: 82, mode: 2, tickets, warTeams }, db, teams.map((team) => ({ team })), [0, 0]);
    war([1, 0], [0], [30, 30]);
    assert.strictEqual(clan.clans.get(81).wins, 0, 'war against an empty side does not count');
    war([1, 1], [0, 1], [12, 0]);
    war([1, 1], [0, 1], [5, 5]);
    war([1, 1], [0], [3, 9]);
    const [c1, c2] = [clan.clans.get(81), clan.clans.get(82)];
    assert.deepStrictEqual([c1.wins, c1.draws, c1.losses, c2.wins, c2.draws, c2.losses], [2, 1, 0, 0, 1, 2], 'tickets win, draw, leaver loses');
    assert.strictEqual(clan.clanExp(c1), 2500);
    clan.clans.delete(81);
    clan.clans.delete(82);
  }

  // Emblem uploads: PNG/JPEG/BMP only, size and dimensions capped
  {
    const { checkUpload, galleryEmblem, imageInfo } = require('../game/emblems');
    const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
    assert.strictEqual(checkUpload(png(32, 32)), undefined, '32x32 PNG accepted');
    assert.ok(checkUpload(png(4000, 32)), 'too wide refused');
    assert.ok(checkUpload(Buffer.from('<svg onload=alert(1)>')), 'not an image refused');
    assert.ok(checkUpload(Buffer.alloc(70 * 1024, 0x42)), 'too large refused');
    assert.deepStrictEqual(imageInfo(galleryEmblem(0)), { type: 'image/bmp', w: 32, h: 32 });
  }

  // Website sign-on tokens: well-formed only, one per account (a new login replaces the old one)
  {
    const { webTokenUser, addWebToken } = require('../game/internal-client');
    const a = 'a'.repeat(32), b = 'b'.repeat(32);
    addWebToken('NULL', { userId: 1 });
    assert.strictEqual(webTokenUser('NULL'), null, 'malformed token ignored');
    addWebToken(a, { userId: 1, username: 'u' });
    assert.strictEqual(webTokenUser(a).userId, 1);
    addWebToken(b, { userId: 1, username: 'u' });
    assert.strictEqual(webTokenUser(a), null, 'old token gone after a new login');
    assert.strictEqual(webTokenUser(b).userId, 1);
  }

  // Movement anticheat: normal running passes, 2x speed and a teleport are flagged, respawns are not
  {
    const { checkMovement, markSpawn } = require('../game/anticheat');
    const flags = [];
    const onStrike = (u, kind) => (flags.push(kind), kind);
    const run = (u, speed, from, ms = 3000) => {
      for (let t = 0; t <= ms; t += 110) checkMovement(u, { x: from + (speed * t) / 1000, h: 0, z: 0, t: 100000 + t }, onStrike);
    };
    const honest = { channel: 1 };
    run(honest, 340, 0);
    assert.deepStrictEqual(flags, [], 'sprinting at 340 u/s is fine');
    run({ channel: 1 }, 700, 0);
    assert.ok(flags.includes('speed'), '700 u/s is a speedhack');
    flags.length = 0;
    const jumper = { channel: 1 };
    checkMovement(jumper, { x: 0, h: 0, z: 0, t: 200000 }, onStrike);
    checkMovement(jumper, { x: 4000, h: 0, z: 0, t: 200110 }, onStrike);
    assert.deepStrictEqual(flags, ['teleport'], '4000 units in one frame');
    flags.length = 0;
    markSpawn(jumper); // respawn: the next big jump is legitimate
    checkMovement(jumper, { x: 9000, h: 0, z: 0, t: Date.now() + 100 }, onStrike);
    assert.deepStrictEqual(flags, [], 'no teleport right after a respawn');
    run({ channel: 2 }, 900, 0);
    assert.deepStrictEqual(flags, [], 'Urban Ops not checked (vehicles)');

    // client clock: honest replies (with one 2.4 s late, as seen live) pass, a 2x clock is caught within ~10 s
    const { checkClock } = require('../game/anticheat');
    const pings = (u, deltas) => {
      let tick = 1e6, now = 0;
      deltas.forEach((d, i) => { tick += d; now += i === 5 ? 7408 : i === 6 ? 2596 : 5000; checkClock(u, tick, now, onStrike); });
    };
    pings({}, Array(20).fill(5010));
    assert.deepStrictEqual(flags, [], 'normal clock, one late reply');
    pings({}, [...Array(5).fill(5000), ...Array(4).fill(10200)]);
    assert.ok(flags.length && flags.every((k) => k === 'speed'), '2x clock');

    // superjump: 800 units up in one frame, while a normal 60-unit jump passes
    flags.length = 0;
    const hopper = { channel: 1 };
    [0, 60, 0].forEach((h, i) => checkMovement(hopper, { x: 0, h, z: 0, t: 300000 + i * 110 }, onStrike));
    assert.deepStrictEqual(flags, [], 'normal jump');
    checkMovement(hopper, { x: 0, h: 800, z: 0, t: 300440 }, onStrike);
    assert.deepStrictEqual(flags, ['superjump'], 'superjump');

    // no fall damage: a long fall that lands needs the client's fall-damage report within 1.5 s
    const { fallDamaged } = require('../game/anticheat');
    const fall = (u, report) => {
      flags.length = 0;
      const hs = [700, 650, 500, 300, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      hs.forEach((h, i) => {
        if (report && i === 7) fallDamaged(u);
        checkMovement(u, { x: 0, h, z: 0, t: 400000 + i * 110 }, onStrike);
      });
    };
    fall({ channel: 1 }, true);
    assert.deepStrictEqual(flags, [], 'fall with damage reported');
    fall({ channel: 1 }, false);
    assert.deepStrictEqual(flags, ['nofall'], 'fall without damage');

    // teleport straight down under the map (OPK hiding) counts too
    flags.length = 0;
    const diver = { channel: 1 };
    checkMovement(diver, { x: 0, h: 0, z: 0, t: 500000 }, onStrike);
    checkMovement(diver, { x: 0, h: -3000, z: 0, t: 500110 }, onStrike);
    assert.deepStrictEqual(flags, ['teleport'], 'under the map');
  }

  // OPK: a hit whose impact point is far from where the victim says it is gets dropped
  {
    const { HANDLERS, SUB } = require('../game/gamesubs');
    const a = { id: 601, sessionId: 601, displayname: 'Opk', socket: { sendPacket() {}, destroy() {} }, equipment: { 3: ['DB01'] } };
    const v = { id: 602, sessionId: 602, pos: { x: 5000, h: 0, z: 5000, t: Date.now() } };
    a.socket.user = a;
    users.set(601, a).set(602, v);
    const victim = { sessionId: 602, slot: 4, team: 1, alive: true, health: 1000 };
    const room = { state: 2, mode: 2, friendlyFire: false, players: new Map([[601, { slot: 0, team: 0, class: 3, alive: true }], [602, victim]]) };
    const hit = (x, z) => HANDLERS[SUB.PLAYER_DAMAGE](room, room.players.get(601),
      ['0', '1', '1', '4', '0', '1', '0', '4', '0', '0', '0', '1240', '0', '0', String(x), '20', String(z), '4', '0', '9', '5', '0', 'DB01'], a, null);
    assert.strictEqual(hit(200, 300), null, 'impact 6000 units from the victim: dropped');
    assert.strictEqual(victim.health, 1000);
    users.delete(601);
    users.delete(602);
  }

  // GM /takemaster, /setmaster: master moves, announced as a "leave" of an empty slot; impossible in a full room
  {
    const { setMaster } = require('../game/rooms');
    const { xorBuffer } = require('../lib/packet');
    const sent = [];
    const mk = (sid) => ({ id: sid, sessionId: sid, socket: { write: (b) => sent.push(xorBuffer(b, 0x96).toString('utf8')) } });
    users.set(801, mk(801)).set(802, mk(802));
    const room = { id: 9, maxPlayers: 4, master: 0, players: new Map([[801, { sessionId: 801, slot: 0 }], [802, { sessionId: 802, slot: 2, ready: false }]]) };
    assert.ok(setMaster(room, room.players.get(802)));
    assert.strictEqual(room.master, 2);
    assert.ok(room.players.get(802).ready, 'new master is ready');
    assert.ok(sent.length === 2 && sent[0].includes(' 29504 1 -1 3 2 2 '), 'leave of empty slot 3 with master 2');
    room.maxPlayers = 3;
    room.players.set(803, { sessionId: 803, slot: 1 });
    room.players.set(804, { sessionId: 804, slot: 2 });
    assert.strictEqual(setMaster(room, room.players.get(801)), false, 'full room');
    users.delete(801);
    users.delete(802);
  }

  // Bans: a temporary one is lifted after ban_until, a running or permanent one holds
  {
    const { isBanned } = require('../auth/handlers');
    const lifted = [];
    const db = { query: async (sql, p) => (lifted.push(p[0]), [{}]) };
    const now = Date.now() / 1000;
    assert.strictEqual(await isBanned(db, { id: 1, status: 1, ban_until: 0 }), false, 'not banned');
    assert.strictEqual(await isBanned(db, { id: 2, status: 0, ban_until: 0 }), true, 'permanent');
    assert.strictEqual(await isBanned(db, { id: 3, status: 0, ban_until: now + 3600 }), true, 'tempban running');
    assert.strictEqual(await isBanned(db, { id: 4, status: 0, ban_until: now - 1 }), false, 'tempban over');
    assert.deepStrictEqual(lifted, [4], 'only the expired one is lifted');
  }

  // Anticheat strikes are kept for /strikes and whispered to online GMs
  {
    const { strike } = require('../game/anticheat');
    const seen = [];
    const mk = (sid, name, isGm) => {
      const u = { id: sid, sessionId: sid, displayname: name, isGm, socket: { sendPacket: (id, f) => seen.push([name, f.at(-1)]), destroy() {} } };
      u.socket.user = u;
      return u;
    };
    const cheat = mk(701, 'Cheat', false);
    const gm = mk(702, 'Boss', true);
    users.set(701, cheat).set(702, gm);
    strike(cheat, 'speed', 'client clock 2.00x');
    assert.strictEqual(cheat.ac.history[0].kind, 'speed');
    assert.ok(seen.some(([to, text]) => to === 'Boss' && text.includes('AC Cheat: speed')), 'GM alerted');
    users.delete(701);
    users.delete(702);
  }

  process.stdout.write('test-hardening: ok\n');
})().catch((err) => {
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
