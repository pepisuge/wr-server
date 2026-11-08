// Dataset recorder for the aim-trainer idea: WR_RECORD=<file> appends one JSON line per event, nothing happens when unset.
//   {t, e:'frame', slot, x, h, z, yaw, pitch, mv:[fwd,back,right,left], st, crouch, fire:[b24,b26], hp, ammo}  every 0x31 movement frame
//   {t, e:'hit',   from, to, bone, weapon, dmg, hs, hp}   a damage packet the server accepted (hp = victim's health after)
//   {t, e:'spawn', slot}
// Frame layout: docs/protocol/udp.md (decoded from real client traffic).
const fs = require('fs');

const FILE = process.env.WR_RECORD;

function record(o) {
  if (FILE) fs.appendFileSync(FILE, JSON.stringify({ t: Date.now(), ...o }) + '\n');
}

// `msg` = a whole relayed tunnel datagram (29-byte header + body, XOR 0xc3 on the body); body[0] is the length's high byte.
function recordFrame(msg) {
  if (!FILE || msg.length < 29 + 97) return;
  const s = Buffer.from(msg.subarray(30, 29 + 97)).map((x) => x ^ 0xc3);
  record({
    e: 'frame',
    slot: s.readUInt16LE(0),
    x: s.readFloatLE(28), h: s.readFloatLE(32), z: s.readFloatLE(36),
    yaw: s.readFloatLE(12), pitch: s.readFloatLE(44),
    mv: [s[2], s[3], s[4], s[5]], st: s[22], crouch: s[20], fire: [s[24], s[26]],
    hp: s.readFloatLE(60), ammo: s[68],
  });
}

module.exports = { record, recordFrame };
