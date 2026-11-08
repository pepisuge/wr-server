const { registerServer, unregisterServer } = require('./server-manager');
const config = require('../lib/config');

const AUTHORIZATION = 0x1000;

// A Game server registering itself right after connecting. Fields (ported
// from Authorization/Handlers/Internal/Authorization.cs):
// [errorCode(=1), key, name, ip, port, type]. The reference never checks the key; we do, because a
// registered server receives every login's session (PLAYER_AUTHORIZATION) - see config `game.serverKey`.
function handleAuthorization(socket, pkt) {
  const [errorCode, key, name = '', ip, , type] = pkt.blocks;
  if (Number(errorCode) !== 1 || key !== config.game.serverKey) {
    console.log(`Internal: rejected game server registration from ${socket.remoteAddress} (bad key)`);
    socket.end();
    return;
  }
  const serverId = registerServer(name.trim(), ip, Number(type), socket);
  socket.on('close', () => unregisterServer(serverId)); // a restarted game server must not leave a stale list entry behind
  socket.sendPacket(AUTHORIZATION, [1, serverId]);
  console.log(`Internal: registered game server "${name.trim()}" as id ${serverId}`);
}

module.exports = { [AUTHORIZATION]: handleAuthorization };
