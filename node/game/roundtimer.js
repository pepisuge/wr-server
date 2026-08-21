const { broadcastPacket } = require('../lib/xor-socket');
const { XOR } = require('../lib/constants');
const { users } = require('./state');

const GAME_TICK = 0x7540;

// Ported (loosely) from Room.Process() + Packets/GameTick.cs. The reference
// runs a real per-room thread driving round timers, win conditions, vehicle
// respawns, and damage/kill scoring - none of which exist here. This is
// just the heartbeat: UpTick/DownTick incrementing once a second, broadcast
// so the client's spawn-counter UI has something to count. Scoreboard
// fields are hardcoded 0 - no kill/ticket tracking exists yet.
function startRoundTimer(room) {
  room.upTick = 0;
  room.downTick = 3600000; // 1 hour - no win condition ends it early yet
  room.tickInterval = setInterval(() => {
    const sockets = [...room.players.keys()].map((sid) => users.get(sid)?.socket).filter(Boolean);
    if (!sockets.length) {
      stopRoundTimer(room);
      return;
    }
    room.upTick += 1000;
    room.downTick -= 1000;
    broadcastPacket(sockets, XOR.external, GAME_TICK, [room.upTick, room.downTick, 0, 0, 0, 0, 2, 0, 30]);
  }, 1000);
}

function stopRoundTimer(room) {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}

module.exports = { startRoundTimer, stopRoundTimer };
