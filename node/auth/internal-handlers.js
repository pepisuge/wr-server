const { registerServer } = require('./server-manager');

const AUTHORIZATION = 0x1000;

// A Game server registering itself right after connecting. Fields (ported
// from Authorization/Handlers/Internal/Authorization.cs):
// [errorCode(=1), key, name, ip, port, type]. The key is read but never
// actually checked against anything in the reference server either.
function handleAuthorization(socket, pkt) {
  const [errorCode, , name, ip, , type] = pkt.blocks;
  if (Number(errorCode) !== 1) {
    socket.end();
    return;
  }
  const serverId = registerServer(name.trim(), ip, Number(type));
  socket.sendPacket(AUTHORIZATION, [1, serverId]);
  console.log(`Internal: registered game server "${name.trim()}" as id ${serverId}`);
}

module.exports = { [AUTHORIZATION]: handleAuthorization };
