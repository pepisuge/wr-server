const net = require('net');
const { wrapSocket } = require('../lib/xor-socket');
const { PORTS, XOR } = require('../lib/constants');

const CONNECTION = 0x1200; // greeting the Auth server sends right on accept
const AUTHORIZATION = 0x1000;

// Registers this Game server with the Auth server over the internal channel.
// Ported from Game/Networking/ServerClient.cs + Game/Handlers/Internal/{Connection,Authorization}.cs:
// connect -> wait for the greeting -> send our registration -> wait for the "you're server #N" reply.
function connectToAuthServer(config) {
  const socket = net.connect(PORTS.internal, config.authServerIp, () => {
    console.log('Internal: connected to Auth server');
  });

  wrapSocket(socket, XOR.internalGame, (pkt) => {
    console.log(`Internal IN tick=${pkt.tick} id=${pkt.id} blocks=[${pkt.blocks.join(', ')}]`);

    if (pkt.id === CONNECTION) {
      socket.sendPacket(AUTHORIZATION, [1, config.serverKey, `${config.serverName} `, config.serverIp, PORTS.game, 0]);
    } else if (pkt.id === AUTHORIZATION) {
      const [errorCode, serverId] = pkt.blocks;
      if (Number(errorCode) === 1) {
        console.log(`Internal: authorized as server #${serverId}`);
      } else {
        console.log(`Internal: authorization failed, error code ${errorCode}`);
      }
    }
  });

  socket.on('error', (err) => console.log(`Internal: socket error: ${err.message}`));
  socket.on('close', () => console.log('Internal: disconnected from Auth server'));

  return socket;
}

module.exports = { connectToAuthServer };
