function xorBuffer(buf, key) {
  const out = Buffer.allocUnsafe(buf.length); // every byte is overwritten below, alloc's zero-fill is wasted work
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
  return out;
}

function parsePacket(buf) {
  const tokens = buf.toString('utf8').split(' ');
  return { tick: Number(tokens[0]), id: Number(tokens[1]), blocks: tokens.slice(2, -1) };
}

function buildPacket(id, fields = []) {
  // Most fields are numbers, which never contain a space - skip the regex for those.
  const escaped = fields.map((f) => {
    const s = String(f);
    return s.indexOf(' ') === -1 ? s : s.replace(/ /g, '\x1D');
  });
  const str = [Date.now() & 0x7fffffff, id, ...escaped].join(' ') + ' \n';
  return Buffer.from(str, 'utf8');
}

module.exports = { xorBuffer, parsePacket, buildPacket };
