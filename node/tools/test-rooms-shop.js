// Runnable check for rooms.js (join/leave/master/kick) and shop.js (price, lease, money, double buy). No DB needed:
// node tools/test-rooms-shop.js
const assert = require('assert');
const { users } = require('../game/state');
const { loadItems } = require('../game/items');
const rooms = require('../game/rooms');
const { handleItemshop, ITEMSHOP } = require('../game/shop');

let nextSession = 1;
function mkUser(o = {}) {
  const socket = {
    out: [], raw: 0, ended: false, destroyed: false,
    sendPacket(id, fields) { this.out.push({ id, fields }); },
    write() { this.raw++; },
    end() { this.ended = true; },
    last(id) { return [...this.out].reverse().find((p) => p.id === id)?.fields; },
  };
  const sessionId = nextSession++;
  const u = { id: 100 + sessionId, sessionId, displayname: `p${sessionId}`, channel: 1, roomId: null, xp: 0, money: 0, premium: 0,
    clanId: -1, kills: 0, deaths: 0, inventory: new Map(), socket, ...o };
  socket.user = u;
  users.set(sessionId, u);
  return u;
}
const noDb = { query: () => Promise.resolve([{ affectedRows: 1 }]) };

function testRooms() {
  const host = mkUser();
  rooms.handleRoomCreation(host.socket, { blocks: ['test', 0, '', 1, 0, 0, 0, 0, 0, 0, 0] });
  assert.strictEqual(host.socket.last(rooms.ROOM_CREATION)[0], 1);
  const roomId = host.roomId;
  const room = require('../game/state').getChannel(1).rooms.get(roomId);
  assert.strictEqual(room.master, 0);
  const half = room.maxPlayers / 2;

  // Auto-balance: the second player goes to the other team's half, the third back to team 0.
  const a = mkUser(), b = mkUser({ premium: 2 });
  rooms.handleRoomJoin(a.socket, { blocks: [roomId, ''] });
  rooms.handleRoomJoin(b.socket, { blocks: [roomId, ''] });
  assert.deepStrictEqual([room.players.get(a.sessionId).slot, room.players.get(a.sessionId).team], [half, 1]);
  assert.deepStrictEqual([room.players.get(b.sessionId).slot, room.players.get(b.sessionId).team], [1, 0]);

  // Rejections: password, host lock, full room.
  const c = mkUser();
  room.hasPassword = true; room.password = 'pw';
  rooms.handleRoomJoin(c.socket, { blocks: [roomId, 'nope'] });
  assert.strictEqual(c.socket.last(rooms.ROOM_JOIN)[0], 94030);
  room.hasPassword = false; room.userLimit = true;
  rooms.handleRoomJoin(c.socket, { blocks: [roomId, ''] });
  assert.strictEqual(c.socket.last(rooms.ROOM_JOIN)[0], 94060);
  room.userLimit = false; const realMax = room.maxPlayers; room.maxPlayers = room.players.size;
  rooms.handleRoomJoin(c.socket, { blocks: [roomId, ''] });
  assert.strictEqual(c.socket.last(rooms.ROOM_JOIN)[0], 94120);
  room.maxPlayers = realMax;
  assert.strictEqual(c.roomId, null);

  // Kick: only the master; the target is only notified, its own RoomLeave removes it (removing here crashed the client).
  rooms.handleRoomKick(a.socket, { blocks: [1] });
  assert.strictEqual(b.socket.last(rooms.ROOM_KICK), undefined, 'non-master cannot kick');
  rooms.handleRoomKick(host.socket, { blocks: [1] });
  assert.deepStrictEqual(b.socket.last(rooms.ROOM_KICK), [1, 1]);
  assert.ok(room.players.has(b.sessionId), 'kick does not remove by itself');

  // Master leaves: the premium player wins over the lower slot; the others get the leave broadcast.
  const rawBefore = a.socket.raw;
  rooms.handleRoomLeave(host.socket, noDb);
  assert.strictEqual(host.roomId, null);
  assert.deepStrictEqual(host.socket.last(rooms.ROOM_LEAVE).slice(0, 5), [1, host.sessionId, 0, 2, 1]);
  assert.strictEqual(room.master, 1, 'premium b becomes master');
  assert.ok(a.socket.raw > rawBefore, 'remaining players get ROOM_LEAVE');

  // Without premium the lowest slot wins; the last one out deletes the room.
  rooms.handleRoomLeave(b.socket, noDb);
  assert.strictEqual(room.master, half);
  rooms.handleRoomLeave(a.socket, noDb);
  assert.strictEqual(require('../game/state').getChannel(1).rooms.has(roomId), false);
  console.log('OK: rooms');
}

async function testShop() {
  // Catalog: GA01 normal (index 4 not for sale), GB01 premium only, GC01 level 10, GD01 not buyable.
  const row = (code, o = {}) => ({ code, active: 1, name: code, is_weapon: 0, buyable: 1, req_level: 1, req_premium: 0, cost: '100,200,300,400,-1', ...o });
  const rows = [row('GA01'), row('GB01', { req_premium: 1 }), row('GC01', { req_level: 10 }), row('GD01', { buyable: 0 })];
  await loadItems({ query: (sql) => Promise.resolve([sql.includes('item_weapons') ? [] : rows]) });

  let commit = Promise.resolve();
  const queries = [];
  const db = {
    transaction: (fn) => commit.then(() => fn({ query: (sql, p) => (queries.push([sql, p]), Promise.resolve([{ affectedRows: 1 }])) })),
  };
  const shop = handleItemshop(db);
  const buy = (u, code, idx) => shop(u.socket, { blocks: [0x456, code, 0, 0, idx] });

  // Price follows the lease index; memory and DB are charged the same amount.
  const u = mkUser({ money: 1000 });
  await buy(u, 'GA01', 1);
  assert.strictEqual(u.money, 800);
  assert.ok(u.inventory.has('GA01'));
  const ok = u.socket.last(ITEMSHOP);
  assert.deepStrictEqual([ok[0], ok[6]], [1, 800]);
  assert.deepStrictEqual(queries[0][1], [200, u.id, 200]);

  // Double buy: the second packet arrives while the first is still in its transaction.
  let release; commit = new Promise((r) => (release = r));
  const v = mkUser({ money: 1000 });
  const first = buy(v, 'GA01', 0), second = buy(v, 'GA01', 0);
  assert.strictEqual(v.socket.last(ITEMSHOP)[0], 97020, 'second buy rejected');
  release(); await first; await second;
  assert.strictEqual(v.money, 900, 'charged once');

  // Rejections leave money alone.
  const w = mkUser({ money: 150 });
  await buy(w, 'GA01', 1); assert.strictEqual(w.socket.last(ITEMSHOP)[0], 97040);
  await buy(w, 'GB01', 0); assert.strictEqual(w.socket.last(ITEMSHOP)[0], 98010);
  await buy(w, 'GC01', 0); assert.strictEqual(w.socket.last(ITEMSHOP)[0], 97060);
  await buy(w, 'GD01', 0); assert.strictEqual(w.socket.last(ITEMSHOP)[0], 97020);
  assert.strictEqual(w.money, 150);
  await buy(w, 'GA01', 4); assert.ok(w.socket.ended, 'lease not for sale = disconnect');
  const x = mkUser({ money: 150 });
  await buy(x, 'ZZ99', 0); assert.ok(x.socket.ended, 'unknown item = disconnect');
  const y = mkUser({ money: 150 });
  await buy(y, 'GA01', 9); assert.ok(y.socket.ended, 'bad lease index = disconnect');

  // DB failure: memory rolled back, client told it failed, money never negative.
  commit = Promise.reject(new Error('db down')); commit.catch(() => {});
  const z = mkUser({ money: 100 });
  await buy(z, 'GA01', 0);
  assert.strictEqual(z.money, 100);
  assert.ok(!z.inventory.has('GA01'));
  assert.strictEqual(z.socket.last(ITEMSHOP)[0], 97020);
  console.log('OK: shop');
}

testRooms();
testShop().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
