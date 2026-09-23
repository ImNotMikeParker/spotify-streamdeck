/**
 * Generates every static image the plugin ships:
 *  - imgs/actions/<name>/icon.svg  (20x20-ish monochrome icon for the actions list)
 *  - imgs/actions/<name>/key.svg   (default key image)
 *  - imgs/plugin/category-icon.svg
 *  - imgs/plugin/marketplace.png (+@2x)  (PNG is mandatory here, so we rasterise a simple logo ourselves)
 *
 * Glyph paths are read straight out of src/render/svg.ts so the two never drift apart.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "com.mjp.spotifydeck.sdPlugin");
const src = readFileSync(join(root, "src/render/svg.ts"), "utf8");
const glyphs = {};
for (const m of src.matchAll(/^\s+(\w+):\s*\n?\s*"([^"]+)",?$/gm)) glyphs[m[1]] = m[2];
if (!glyphs.play) throw new Error("Could not parse glyphs from svg.ts");

const GREEN = "#1DB954";

const actions = {
  "play-pause": { glyph: glyphs.play },
  "now-playing": { glyph: glyphs.spotify, stroke: false },
  next: { glyph: glyphs.next },
  previous: { glyph: glyphs.previous },
  like: { glyph: glyphs.heart, stroke: true },
  shuffle: { glyph: glyphs.shuffle, stroke: true },
  repeat: { glyph: glyphs.repeat, stroke: true },
  volume: { glyph: glyphs.volume + " " + glyphs.volumeWaves },
  seek: { glyph: glyphs.seekFwd, stroke: true },
  "play-uri": { glyph: glyphs.playlist, stroke: true },
  "add-to-playlist": { glyph: glyphs.plus, stroke: true },
  device: { glyph: glyphs.device, stroke: true },
};

function path(d, color, stroke, width = 10) {
  return stroke
    ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${d}" fill="${color}"/>`;
}

for (const [name, a] of Object.entries(actions)) {
  const dir = join(plugin, "imgs/actions", name);
  mkdirSync(dir, { recursive: true });
  // Action list icon: white glyph, transparent background.
  writeFileSync(
    join(dir, "icon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 144 144"><g transform="translate(14 14) scale(0.8)">${path(a.glyph, "#ffffff", a.stroke, 12)}</g></svg>`,
  );
  // Default key image.
  writeFileSync(
    join(dir, "key.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="14" fill="#121212"/><g transform="translate(28 28) scale(0.6)">${path(a.glyph, "#ffffff", a.stroke)}</g></svg>`,
  );
}

mkdirSync(join(plugin, "imgs/plugin"), { recursive: true });
writeFileSync(
  join(plugin, "imgs/plugin/category-icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 144 144"><circle cx="72" cy="72" r="60" fill="#ffffff"/><path d="M40 56 q36 -10 70 6 M44 76 q30 -8 58 5 M48 96 q24 -6 46 4" fill="none" stroke="#000" stroke-width="10" stroke-linecap="round"/></svg>`,
);

// ---- Minimal PNG writer (RGBA, no deps) -------------------------------------

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rasterise the logo: rounded dark square, green circle, three white "sound wave" arcs. 4x supersampled. */
function logo(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  const r = size / 2;
  const inside = (x, y) => {
    // Rounded square background.
    const rad = size * 0.22;
    const dx = Math.max(Math.abs(x - r) - (r - rad), 0);
    const dy = Math.max(Math.abs(y - r) - (r - rad), 0);
    if (Math.hypot(dx, dy) > rad) return null;
    // Green disc.
    const d = Math.hypot(x - r, y - r);
    if (d > size * 0.36) return [18, 18, 18];
    // Three arcs (parts of circles centred below-left, like the Spotify-style waves but our own geometry).
    const cx = r - size * 0.05;
    const cy = r + size * 0.42;
    const dd = Math.hypot(x - cx, y - cy);
    const ang = Math.atan2(cy - y, x - cx); // 0..pi above centre
    const withinAngle = ang > Math.PI * 0.25 && ang < Math.PI * 0.75;
    for (const [rr, w] of [
      [size * 0.2, size * 0.045],
      [size * 0.33, size * 0.05],
      [size * 0.46, size * 0.055],
    ]) {
      if (withinAngle && Math.abs(dd - rr) < w / 2) return [255, 255, 255];
    }
    return [29, 185, 84];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (c) {
            acc[0] += c[0];
            acc[1] += c[1];
            acc[2] += c[2];
            acc[3] += 255;
          }
        }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const a = acc[3] / n;
      const cov = acc[3] / 255 || 1;
      rgba[i] = Math.round(acc[0] / cov);
      rgba[i + 1] = Math.round(acc[1] / cov);
      rgba[i + 2] = Math.round(acc[2] / cov);
      rgba[i + 3] = Math.round(a);
    }
  }
  return png(size, size, rgba);
}

writeFileSync(join(plugin, "imgs/plugin/marketplace.png"), logo(256));
writeFileSync(join(plugin, "imgs/plugin/marketplace@2x.png"), logo(512));
console.log("icons written");
