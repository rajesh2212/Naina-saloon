'use strict';
/**
 * `npm run art:ticket` — rebuild the small decorative copies of the studio's own
 * cut-outs: the three embedded in the ticket PDF and the frangipani sprig used
 * across the site. The full-size originals in `public/assets/art/` are the
 * source of truth and stay as they were supplied; only these derived files are
 * referenced by the app, so a download weighs ~150 KB instead of 1.8 MB.
 *
 * Pure Node — it decodes and writes the PNGs itself with `zlib`, so adding this
 * does not pull in an image library. Downsample is area-weighted with
 * alpha-premultiplied colour, which keeps a soft edge from darkening.
 * Run it again after dropping a new flower, cat or portrait over an original.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ART = path.join(__dirname, '..', 'public', 'assets', 'art');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function decode(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG: ' + file);
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('ascii', off + 4, off + 8);
    const body = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = body;
    if (type === 'IDAT') idat.push(Buffer.from(body));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) throw new Error('need 8-bit RGBA: ' + file);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos];
      pos += 1;
      const a = x >= 4 ? line[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 4 ? prev[x - 4] : 0;
      let v;
      switch (filter) {
        case 0: v = value; break;
        case 1: v = value + a; break;
        case 2: v = value + b; break;
        case 3: v = value + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      line[x] = v & 0xff;
    }
  }
  return { width, height, pixels: out };
}

/** Area-weighted average of every source pixel that lands in the box. */
function shrink({ width, height, pixels }, targetWidth) {
  const scale = targetWidth / width;
  const targetHeight = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor(ty / scale);
    const y1 = Math.max(y0 + 1, Math.floor((ty + 1) / scale));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor(tx / scale);
      const x1 = Math.max(x0 + 1, Math.floor((tx + 1) / scale));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < Math.min(y1, height); y += 1) {
        for (let x = x0; x < Math.min(x1, width); x += 1) {
          const i = (y * width + x) * 4;
          const alpha = pixels[i + 3];
          // weight colour by coverage so transparent edges do not darken it
          r += pixels[i] * alpha; g += pixels[i + 1] * alpha; b += pixels[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (ty * targetWidth + tx) * 4;
      if (a === 0) { out[o + 3] = 0; continue; }
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: targetWidth, height: targetHeight, pixels: out };
}

function encode({ width, height, pixels }, file) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const body = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    body[y * (stride + 1)] = 0;
    pixels.copy(body, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(body, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return fs.statSync(file).size;
}

for (const [source, target, width] of [
  ['hero-portrait-cutout.png', 'ticket-portrait.png', 240],
  ['flower-stem.png', 'ticket-flower.png', 96],
  ['cat-cutout.png', 'ticket-cat.png', 132],
  ['flower-stem.png', 'flower-accent.png', 150],
]) {
  const image = shrink(decode(path.join(ART, source)), width);
  const size = encode(image, path.join(ART, target));
  console.log(`${target}: ${image.width}x${image.height} ${Math.round(size / 1024)} KB`);
}
