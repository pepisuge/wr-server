// Clan emblems for the website and the game client: a generated gallery (the client ships none) and validation of
// uploaded images. The client loads emblems through Direct3D, which reads BMP, PNG and JPEG whatever the file name.
const crypto = require('crypto');

const SIZE = 32;
const MAX_UPLOAD = 64 * 1024;
const MAX_SIDE = 256;
const BACKGROUND = [40, 41, 42];
const COLOURS = [[242, 176, 30], [228, 228, 228], [232, 145, 45], [229, 83, 61]]; // site palette: amber, silver, orange, alert red

// Shapes on [-1, 1]^2, y pointing down; `badge` shapes get a darker inner copy (scaled to 70%) for a rim.
const SHAPES = [
  { badge: true, inside: (x, y) => Math.abs(x) <= 0.8 && y >= -0.85 && (y <= 0.2 || Math.abs(x) <= ((0.95 - y) * 0.8) / 0.75) }, // shield
  { badge: true, inside: (x, y) => x * x + y * y <= 0.64 }, // round
  { badge: false, inside: star },
  { badge: true, inside: (x, y) => Math.abs(x) + Math.abs(y) <= 0.85 }, // diamond
  { badge: true, inside: (x, y) => Math.abs(y) <= 0.72 && Math.abs(x) + Math.abs(y) * 0.577 <= 0.85 }, // hexagon
  { badge: false, inside: (x, y) => { const v = y + 0.8 * Math.abs(x); return Math.abs(x) <= 0.85 && ((v > -0.6 && v < -0.2) || (v > 0.1 && v < 0.5)); } }, // chevrons
];
const GALLERY_SIZE = SHAPES.length * COLOURS.length;

// 5-point star: 10 vertices alternating outer/inner radius, even-odd point-in-polygon test
const STAR = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 ? 0.38 : 0.92;
  const a = (i * Math.PI) / 5;
  return [r * Math.sin(a), -r * Math.cos(a) + 0.06];
});
function star(x, y) {
  let inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [xi, yi] = STAR[i];
    const [xj, yj] = STAR[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bmp(pixel) {
  const row = SIZE * 3;
  const buf = Buffer.alloc(54 + row * SIZE);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(SIZE, 18);
  buf.writeInt32LE(SIZE, 22); // bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = pixel(x, SIZE - 1 - y);
      const o = 54 + y * row + x * 3;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
    }
  }
  return buf;
}

const cache = new Map();

// Gallery emblem n (0..GALLERY_SIZE-1), 4x4 supersampled.
function galleryEmblem(n) {
  if (cache.has(n)) return cache.get(n);
  const shape = SHAPES[Math.floor(n / COLOURS.length)];
  const colour = COLOURS[n % COLOURS.length];
  const dark = colour.map((c) => Math.round(c * 0.45));
  const img = bmp((px, py) => {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const x = ((px + (sx + 0.5) / 4) / SIZE) * 2 - 1;
        const y = ((py + (sy + 0.5) / 4) / SIZE) * 2 - 1;
        let c = BACKGROUND;
        if (shape.inside(x, y)) c = shape.badge && shape.inside(x / 0.7, y / 0.7) && !shape.inside(x / 0.45, y / 0.45) ? dark : colour;
        for (let i = 0; i < 3; i++) acc[i] += c[i];
      }
    }
    return acc.map((v) => Math.round(v / 16));
  });
  cache.set(n, img);
  return img;
}

// A clan's emblem: uploaded image, chosen gallery emblem ('g<n>'), or a gallery emblem picked from the name.
function clanEmblem(clan) {
  if (clan.emblem === 'u' && clan.emblemData) return { data: clan.emblemData, type: imageInfo(clan.emblemData).type };
  const chosen = /^g(\d+)$/.exec(clan.emblem || '');
  const n = chosen && Number(chosen[1]) < GALLERY_SIZE ? Number(chosen[1]) : crypto.createHash('md5').update(clan.name.toLowerCase()).digest()[0] % GALLERY_SIZE;
  return { data: galleryEmblem(n), type: 'image/bmp' };
}

// Type and size from the file header: PNG, JPEG or BMP only. null for anything else.
function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 26 && buf.toString('latin1', 0, 2) === 'BM') return { type: 'image/bmp', w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // walk the JPEG segments to the frame header (SOFn, not DHT/JPG/DAC)
    for (let o = 2; o + 9 < buf.length; ) {
      if (buf[o] !== 0xff) return null;
      const marker = buf[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'image/jpeg', w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

// Error message, or nothing when the upload is a usable emblem.
function checkUpload(buf) {
  if (!buf || !buf.length) return 'Choose an image file.';
  if (buf.length > MAX_UPLOAD) return `The image must be at most ${MAX_UPLOAD / 1024} KB.`;
  const info = imageInfo(buf);
  if (!info) return 'Use a PNG, JPEG or BMP image.';
  if (info.w < 8 || info.h < 8 || info.w > MAX_SIDE || info.h > MAX_SIDE) return `The image must be 8 to ${MAX_SIDE} pixels per side (32x32 looks best).`;
}

module.exports = { GALLERY_SIZE, MAX_UPLOAD, galleryEmblem, clanEmblem, checkUpload, imageInfo };
