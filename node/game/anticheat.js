// Movement checks on the positions players report in UDP movement frames (0x31): speedhack and teleport. The client is
// the only source of positions, so this judges what it says, not what happened; thresholds come from recorded play
// (datasets: real infantry tops out at ~340 u/s, bots at ~355; a frame every ~0.11 s).
// ponytail: CQC channel only - Urban Ops / Battle Group vehicles move faster than infantry and their frames aren't
// told apart yet; extend once vehicle frames are decoded.
const MAX_SPEED = 500; // u/s over the window, horizontal
const WINDOW_MS = 1000;
const TELEPORT = 1500; // units between two samples less than a second apart
const MIN_SAMPLE_MS = 50; // the same frame reaches the server once per room peer: ignore copies
const SPAWN_GRACE_MS = 3000; // respawns legitimately jump across the map
const STRIKE_WINDOW_MS = 60000;
const STRIKES_TO_KICK = 3;
const STRIKE_COOLDOWN_MS = 3000; // one strike per kind per 3 s, so one burst isn't three strikes
const CQC = 1;

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function state(u) {
  if (!u.ac) u.ac = { samples: [], strikes: [], lastStrike: {}, spawnAt: 0 };
  return u.ac;
}

// Called from gamesubs.js when the player (re)spawns.
function markSpawn(u) {
  const s = state(u);
  s.spawnAt = Date.now();
  s.samples = [];
}

// Returns the violation found (for tests and logs), or null.
function checkMovement(u, pos, onStrike = strike) {
  if (u.channel !== CQC) return null;
  const s = state(u);
  if (pos.t - s.spawnAt < SPAWN_GRACE_MS) {
    s.samples = [];
    return null;
  }
  const last = s.samples[s.samples.length - 1];
  if (last && pos.t - last.t < MIN_SAMPLE_MS) return null;

  if (last && pos.t - last.t < 1000 && dist(last, pos) > TELEPORT) {
    s.samples = [pos];
    return onStrike(u, 'teleport', `${Math.round(dist(last, pos))} units in ${pos.t - last.t} ms`);
  }
  s.samples.push(pos);
  while (s.samples.length > 1 && pos.t - s.samples[0].t > WINDOW_MS) s.samples.shift();
  const first = s.samples[0];
  // Only once the window is (nearly) full: a single short gap says little about speed.
  if (pos.t - first.t < WINDOW_MS * 0.8) return null;
  let path = 0;
  for (let i = 1; i < s.samples.length; i++) path += dist(s.samples[i - 1], s.samples[i]);
  const speed = (path * 1000) / (pos.t - first.t);
  if (speed <= MAX_SPEED) return null;
  s.samples = [pos];
  return onStrike(u, 'speed', `${Math.round(speed)} u/s`);
}

function strike(u, kind, detail) {
  const s = state(u);
  const now = Date.now();
  if (now - (s.lastStrike[kind] || 0) < STRIKE_COOLDOWN_MS) return kind;
  s.lastStrike[kind] = now;
  s.strikes = s.strikes.filter((t) => now - t < STRIKE_WINDOW_MS);
  s.strikes.push(now);
  console.warn(`anticheat: ${u.displayname} (${u.id}) ${kind}: ${detail} [${s.strikes.length}/${STRIKES_TO_KICK}]`);
  require('./chat').sendSystemWhisper(u.socket, `Anticheat: ${kind} detected (${s.strikes.length}/${STRIKES_TO_KICK}).`);
  if (s.strikes.length >= STRIKES_TO_KICK) {
    console.warn(`anticheat: ${u.displayname} (${u.id}) disconnected`);
    u.socket.destroy();
  }
  return kind;
}

module.exports = { checkMovement, markSpawn, MAX_SPEED, TELEPORT };
