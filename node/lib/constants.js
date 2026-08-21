const XOR = {
  external: { send: 0x96, receive: 0xc3 }, // client <-> server (login and game)
  internalAuth: { send: 0x23, receive: 0xa3 }, // Authorization server's side of the internal channel
  internalGame: { send: 0xa3, receive: 0x23 }, // Game server's side of the internal channel
};

const PORTS = { internal: 5012, login: 5330, game: 5340, udp1: 5350, udp2: 5351 };

module.exports = { XOR, PORTS };
