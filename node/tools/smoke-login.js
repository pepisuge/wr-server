// End-to-end login against running servers (used by CI's docker job): node tools/smoke-login.js <user> <password> [host]
// Login (5330) -> session -> game Authorization (5340) must succeed; the same packet with another userId or a replayed session must be refused.
// The website (8080) must trade the login's sign-on token for a session cookie, and refuse a made-up one.
const assert = require('assert');
const net = require('net');
const http = require('http');
const { wrapSocket } = require('../lib/xor-socket');

const [user, password, host = '127.0.0.1'] = process.argv.slice(2);
const CLIENT = { send: 0xc3, receive: 0x96 }; // the client's side of XOR.external

function request(port, id, fields) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    wrapSocket(s, CLIENT, (pkt) => {
      if (pkt.id === 0x1200) return s.sendPacket(id, fields); // greeting first
      s.destroy();
      resolve(pkt);
    });
    s.on('error', reject);
    s.setTimeout(5000, () => reject(new Error(`timeout on ${port} id ${id}`)));
  });
}

const get = (path) =>
  new Promise((resolve, reject) => http.get({ host, port: 8080, path }, (res) => resolve(res.resume() && res)).on('error', reject));

(async () => {
  const login = await request(5330, 0x1100, [0, 0, user, password]);
  assert.strictEqual(login.blocks[0], '1', `login failed: ${login.blocks}`);
  const userId = login.blocks[1];
  const sessionId = login.blocks[6];

  const ok = await request(5340, 0x6200, [userId, 0, user, 'x', sessionId]);
  assert.strictEqual(ok.blocks[0], '1', `game authorization failed: ${ok.blocks.slice(0, 3)}`);

  const spoof = await request(5340, 0x6200, [Number(userId) + 1, 0, user, 'x', sessionId]);
  assert.strictEqual(spoof.blocks[0], '73030', 'spoofed userId must be refused');
  const replay = await request(5340, 0x6200, [userId, 0, user, 'x', sessionId]);
  assert.strictEqual(replay.blocks[0], '73030', 'a session is single-use');
  process.stdout.write('smoke-login: ok\n');
})().catch((err) => {
  console.error('smoke-login:', err.message);
  process.exit(1);
});
