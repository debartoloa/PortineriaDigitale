/**
 * generate-icons.js
 * Genera le icone PNG reali (icon-192.png e icon-512.png) per la PWA
 * senza dipendenze esterne, utilizzando esclusivamente i moduli built-in fs e zlib di Node.js.
 *
 * Utilizzo:
 *   node generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Tabella CRC32 per i chunk PNG
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Aggiunge byte di filtro 0 all'inizio di ogni riga
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function blendPixel(rgba, size, x, y, r, g, b, alpha) {
  if (x < 0 || x >= size || y < 0 || y >= size || alpha <= 0) return;
  const idx = (y * size + x) * 4;
  const a = Math.min(1, Math.max(0, alpha));
  const inv = 1 - a;
  rgba[idx] = Math.round(r * a + rgba[idx] * inv);
  rgba[idx + 1] = Math.round(g * a + rgba[idx + 1] * inv);
  rgba[idx + 2] = Math.round(b * a + rgba[idx + 2] * inv);
  rgba[idx + 3] = 255;
}

function fillRect(rgba, size, x0, y0, x1, y1, r, g, b) {
  const minX = Math.max(0, Math.floor(x0 * size));
  const maxX = Math.min(size - 1, Math.ceil(x1 * size));
  const minY = Math.max(0, Math.floor(y0 * size));
  const maxY = Math.min(size - 1, Math.ceil(y1 * size));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      blendPixel(rgba, size, x, y, r, g, b, 1);
    }
  }
}

function fillTriangle(rgba, size, ax, ay, bx, by, cx, cy, r, g, b) {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) * size));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx) * size));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) * size));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy) * size));

  const area = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);

  for (let y = minY; y <= maxY; y++) {
    const py = (y + 0.5) / size;
    for (let x = minX; x <= maxX; x++) {
      const px = (x + 0.5) / size;
      const d1 = area(px, py, ax, ay, bx, by);
      const d2 = area(px, py, bx, by, cx, cy);
      const d3 = area(px, py, cx, cy, ax, ay);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (!(hasNeg && hasPos)) {
        blendPixel(rgba, size, x, y, r, g, b, 1);
      }
    }
  }
}

function fillCircle(rgba, size, cx, cy, radius, r, g, b) {
  const minX = Math.max(0, Math.floor((cx - radius) * size) - 1);
  const maxX = Math.min(size - 1, Math.ceil((cx + radius) * size) + 1);
  const minY = Math.max(0, Math.floor((cy - radius) * size) - 1);
  const maxY = Math.min(size - 1, Math.ceil((cy + radius) * size) + 1);

  for (let y = minY; y <= maxY; y++) {
    const py = (y + 0.5) / size;
    for (let x = minX; x <= maxX; x++) {
      const px = (x + 0.5) / size;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist <= radius) {
        const edge = (radius - dist) * size;
        blendPixel(rgba, size, x, y, r, g, b, Math.min(1, edge));
      }
    }
  }
}

function generateAppIcon(size, filename) {
  const rgba = Buffer.alloc(size * size * 4);

  // Sfondo gradiente blu istituzionale (#1a365d -> #0f233d) compatibile maskable
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(26 * (1 - t) + 15 * t);
    const g = Math.round(54 * (1 - t) + 35 * t);
    const b = Math.round(93 * (1 - t) + 61 * t);
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }

  // Bordo interno sottile oro/azzurro per definizione visiva
  // Tetto scuola (triangolo bianco)
  fillTriangle(rgba, size, 0.50, 0.20, 0.18, 0.42, 0.82, 0.42, 255, 255, 255);
  // Architrave
  fillRect(rgba, size, 0.22, 0.42, 0.78, 0.47, 226, 232, 240);
  // Corpo edificio
  fillRect(rgba, size, 0.25, 0.47, 0.75, 0.78, 255, 255, 255);
  // Base scalinata
  fillRect(rgba, size, 0.20, 0.75, 0.80, 0.80, 203, 213, 225);

  // Portone centrale (#1a365d)
  fillRect(rgba, size, 0.44, 0.58, 0.56, 0.78, 26, 54, 93);
  // Finestre laterali (#2b6cb0)
  fillRect(rgba, size, 0.30, 0.53, 0.39, 0.63, 43, 108, 176);
  fillRect(rgba, size, 0.61, 0.53, 0.70, 0.63, 43, 108, 176);

  // Orologio / stemma sul timpano (#d69e2e)
  fillCircle(rgba, size, 0.50, 0.34, 0.045, 214, 158, 46);

  // Badge verde presenza in basso a destra (#38a169)
  fillCircle(rgba, size, 0.74, 0.74, 0.11, 255, 255, 255);
  fillCircle(rgba, size, 0.74, 0.74, 0.085, 56, 161, 105);

  const pngBuffer = encodePNG(size, size, rgba);
  const outPath = path.join(__dirname, filename);
  fs.writeFileSync(outPath, pngBuffer);
  console.log(`Generata icona: ${filename} (${size}x${size}, ${pngBuffer.length} byte)`);
}

generateAppIcon(192, 'icon-192.png');
generateAppIcon(512, 'icon-512.png');
