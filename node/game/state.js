// Minimal shared state so different connections can see each other: who's
// logged in, which channel/room they're in. Ported concept from
// Managers.UserManager / Managers.ChannelManager, flattened into one module
// since we only have a handful of collections to track.
// ponytail: all in-memory, lost on restart - fine for a dev server.

const users = new Map(); // sessionId -> { userId, sessionId, displayname, socket, channel, roomId }

function getChannel(channels, type) {
  if (!channels.has(type)) channels.set(type, { rooms: new Map() });
  return channels.get(type);
}

// Lowest free room id, starting at 0 - reuses ids freed by destroyed rooms
// instead of counting up forever (matches Channel.GetOpenRoomID() in both
// C# references, which scan for a free slot starting at 0 rather than
// handing out new ones).
function nextFreeRoomId(chan) {
  let id = 0;
  while (chan.rooms.has(id)) id++;
  return id;
}
const channels = new Map(); // channelType -> { rooms: Map<id, room>, nextRoomId }

function lobbyUsersIn(channelType, excludeSessionId) {
  return [...users.values()].filter(
    (u) => u.channel === channelType && u.roomId === null && u.sessionId !== excludeSessionId
  );
}

// Sockets of everyone who receives a room's broadcasts: players plus spectators (room.spectators: sessionId -> spectator id).
function roomSockets(room) {
  return [...room.players.keys(), ...(room.spectators?.keys() ?? [])].map((sid) => users.get(sid)?.socket).filter(Boolean);
}

module.exports = {
  users,
  roomSockets,
  channels,
  getChannel: (type) => getChannel(channels, type),
  lobbyUsersIn,
  nextFreeRoomId,
};
