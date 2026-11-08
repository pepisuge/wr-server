// In-memory registry of Game servers that registered over the internal
// channel. Ponytail: no persistence (entries are dropped when the game server's socket closes) - fine for
// a single dev game server, revisit if we ever run more than one.
const servers = new Map();
let nextId = 1;

function registerServer(name, ip, type, socket) {
  const id = nextId++;
  servers.set(id, { id, name, ip, playerCount: 0, type, socket });
  return id;
}

function getAllAuthorized() {
  return [...servers.values()];
}

function unregisterServer(id) {
  servers.delete(id);
}

module.exports = { registerServer, unregisterServer, getAllAuthorized };
