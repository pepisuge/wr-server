// In-memory registry of Game servers that registered over the internal
// channel. Ponytail: no persistence, no cleanup on disconnect yet - fine for
// a single dev game server, revisit if we ever run more than one.
const servers = new Map();
let nextId = 1;

function registerServer(name, ip, type) {
  const id = nextId++;
  servers.set(id, { id, name, ip, playerCount: 0, type });
  return id;
}

function getAllAuthorized() {
  return [...servers.values()];
}

module.exports = { registerServer, getAllAuthorized };
