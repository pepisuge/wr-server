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
