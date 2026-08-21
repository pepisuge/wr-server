function xorBuffer(buf, key) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
  return out;
}

function parsePacket(buf) {
  const tokens = buf.toString('utf8').split(' ');
  return { tick: Number(tokens[0]), id: Number(tokens[1]), blocks: tokens.slice(2, -1) };
}

function buildPacket(id, fields = []) {
  const escaped = fields.map((f) => String(f).replace(/ /g, '\x1D'));
  const str = [Date.now() & 0x7fffffff, id, ...escaped].join(' ') + ' \n';
  return Buffer.from(str, 'utf8');
}

module.exports = { xorBuffer, parsePacket, buildPacket };
