// Movement checks on the positions players report in UDP movement frames (0x31): speedhack and teleport. The client is
// the only source of positions, so this judges what it says, not what happened; thresholds come from recorded play
// (datasets: real infantry tops out at ~340 u/s, bots at ~355; a frame every ~0.11 s).
// ponytail: CQC channel only - Urban Ops / Battle Group vehicles move faster than infantry and their frames aren't
// told apart yet; extend once vehicle frames are decoded.
const MAX_SPEED = 440; // u/s over the window, horizontal (live 3x speedhack test: 450-480; honest play peaks ~390)
const WINDOW_MS = 1000;
const TELEPORT = 1500; // units between two samples less than a second apart
const MAX_RISE = 350; // height gained within the window (recorded jumps, stairs and ramps: up to ~190)
const MIN_SAMPLE_MS = 50; // the same frame reaches the server once per room peer: ignore copies
const SPAWN_GRACE_MS = 3000; // respawns legitimately jump across the map
const STRIKE_WINDOW_MS = 60000;
const STRIKES_TO_KICK = 3;
const STRIKE_COOLDOWN_MS = 3000; // one strike per kind per 3 s, so one burst isn't three strikes
const CQC = 1;

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.h - b.h, a.z - b.z); // teleports include dropping under the map (OPK)
const FALL_DAMAGE_DROP = 600; // a landing after a fall this high always reported fall damage (live: superjump landings)
const FALL_DAMAGE_WAIT_MS = 1500;

function state(u) {
  if (!u.ac) u.ac = { samples: [], strikes: [], lastStrike: {}, spawnAt: 0 };
  return u.ac;
}

// Speedhacks speed up the client's clock, and every TCP packet carries that clock (`tick`). Between ping replies (every
// 5 s) it advances like the server's own clock within ~25 ms (live; 2x/3x speedhack: 10200/15000 ms per 5 s). Measured
// over windows, not reply to reply, so one delayed reply (network lag) can't look like a fast clock. Works whatever the
// movement looks like: the game caps running speed, 3x only ran ~30% faster.
const CLOCK_CHECKS = [
  { windowMs: 10000, ratio: 1.5 }, // obvious speedhack, caught in ~10 s
  { windowMs: 30000, ratio: 1.2 }, // a subtle one
];

function checkClock(u, tick, now = Date.now(), onStrike = strike) {
  const s = state(u);
  const ticks = (s.ticks = (s.ticks || []).filter((x) => now - x.now <= 40000 && x.tick <= tick)); // drop old and pre-wrap samples
  ticks.push({ tick, now });
  for (const { windowMs, ratio } of CLOCK_CHECKS) {
    const base = [...ticks].reverse().find((x) => now - x.now >= windowMs);
    if (!base) continue;
    const r = (tick - base.tick) / (now - base.now);
    if (r > ratio) {
      s.ticks = [{ tick, now }];
      return onStrike(u, 'speed', `client clock ${r.toFixed(2)}x over ${Math.round((now - base.now) / 1000)} s`);
    }
  }
  return null;
}

// Called from gamesubs.js when the player (re)spawns.
function markSpawn(u) {
  const s = state(u);
  s.spawnAt = Date.now();
  s.samples = [];
  s.heights = [];
  s.fall = null;
}

// The client computes fall damage itself and reports it (EnvironmentDamage, gamesubs.js): "no fall damage" cheats just
// don't. After a long fall that ends on the ground, that report must follow; called when it arrives.
function fallDamaged(u) {
  state(u).fall = null;
}

function checkFall(u, s, pos, onStrike) {
  if (s.fall && pos.t - s.fall.at > FALL_DAMAGE_WAIT_MS) {
    const drop = s.fall.drop;
    s.fall = null;
    return onStrike(u, 'nofall', `landed after ${drop} units without fall damage`);
  }
  s.heights = (s.heights || []).filter((p) => pos.t - p.t < 3000);
  const prev = s.heights[s.heights.length - 1];
  s.heights.push(pos);
  const peak = Math.max(...s.heights.map((p) => p.h));
  if (!s.fall && prev && peak - pos.h > FALL_DAMAGE_DROP && Math.abs(pos.h - prev.h) < 2) {
    s.fall = { at: pos.t, drop: Math.round(peak - pos.h) }; // landed: height stopped changing
    s.heights = [pos];
  }
  return null;
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

  if (last && pos.t - last.t < 1000 && dist3(last, pos) > TELEPORT) {
    s.samples = [pos];
    s.heights = [pos];
    return onStrike(u, 'teleport', `${Math.round(dist3(last, pos))} units in ${pos.t - last.t} ms`);
  }
  const fell = checkFall(u, s, pos, onStrike);
  if (fell) return fell;
  s.samples.push(pos);
  while (s.samples.length > 1 && pos.t - s.samples[0].t > WINDOW_MS) s.samples.shift();
  const rise = pos.h - Math.min(...s.samples.map((p) => p.h));
  if (rise > MAX_RISE) {
    s.samples = [pos];
    return onStrike(u, 'superjump', `${Math.round(rise)} units up in under a second`);
  }
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

module.exports = { checkMovement, checkClock, markSpawn, fallDamaged, strike, MAX_SPEED, TELEPORT };
