/**
 * Renders the Maker Console listing images (1920 x 960 PNG) with headless Edge/Chrome:
 *  assets/marketplace/thumbnail.png, gallery-1.png .. gallery-3.png
 *
 * Key images are produced by the same SVG renderer the plugin uses (src/render/svg.ts), compiled on the fly
 * with tsc into a temp folder, so the pictures match what users actually see.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "assets/marketplace");
mkdirSync(out, { recursive: true });

// 1. Compile the renderer to plain JS we can import here.
const tmp = join(tmpdir(), "simply-spotify-marketing");
mkdirSync(tmp, { recursive: true });
execFileSync("npx", ["tsc", "src/render/svg.ts", "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck"], { cwd: root, stdio: "inherit", shell: true });
writeFileSync(join(tmp, "package.json"), `{ "type": "module" }`);
const { keySvg, glyphs, GREEN, MUTED } = await import(pathToFileURL(join(tmp, "svg.js")).href);

// 2. Fake album art (gradients) so we never ship real cover art we do not own.
const art = (a, b, seed) =>
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="${90 + seed * 30}" cy="${120 + seed * 20}" r="${70 + seed * 10}" fill="#fff" opacity="0.18"/><circle cx="${210 - seed * 20}" cy="${200 - seed * 30}" r="${40 + seed * 8}" fill="#000" opacity="0.18"/></svg>`,
  ).toString("base64");
const ART = [art("#7b2ff7", "#f107a3", 0), art("#0f9b8e", "#1db954", 1), art("#ff8a00", "#e52e71", 2), art("#2b5876", "#4e4376", 3)];

const img = (svg, size = 144) => `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="border-radius:${size * 0.12}px;display:block">`;

const keys = {
  playing: keySvg({ art: ART[0], dim: 0.3, glyph: glyphs.pause, glyphScale: 0.62, progress: 0.42 }),
  paused: keySvg({ art: ART[1], dim: 0.55, glyph: glyphs.play, glyphScale: 0.62, progress: 0.42 }),
  nowPlaying: keySvg({ art: ART[0], dim: 0.15, badge: glyphs.heart, title: "Midnight City", subtitle: "M83", titleSize: 16, progress: 0.42 }),
  nowPlaying2: keySvg({ art: ART[2], dim: 0.15, title: "Golden Hour", subtitle: "JVKE", titleSize: 16, progress: 0.7 }),
  liked: keySvg({ glyph: glyphs.heart, glyphColor: GREEN, glyphScale: 0.6 }),
  unliked: keySvg({ glyph: glyphs.heart, glyphStroke: true, glyphScale: 0.6 }),
  shuffleOn: keySvg({ glyph: glyphs.shuffle, glyphStroke: true, glyphColor: GREEN, glyphScale: 0.6, badge: glyphs.check, badgeStroke: true }),
  repeatOne: keySvg({ glyph: glyphs.repeat, glyphStroke: true, glyphColor: GREEN, glyphScale: 0.6, badgeText: "1" }),
  next: keySvg({ glyph: glyphs.next, glyphScale: 0.6 }),
  prev: keySvg({ glyph: glyphs.previous, glyphScale: 0.6 }),
  volume: keySvg({ glyph: glyphs.volume + " " + glyphs.volumeWaves, glyphScale: 0.42, glyphY: -26, title: "57%", titleSize: 22, titleColor: GREEN, subtitle: "+10" }),
  playlist: keySvg({ glyph: glyphs.playlist, glyphStroke: true, glyphColor: GREEN, glyphScale: 0.5, glyphY: -14, title: "Deep Focus", titleSize: 15, titleColor: GREEN, ring: GREEN }),
  addTo: keySvg({ glyph: glyphs.playlist, glyphStroke: true, glyphScale: 0.5, glyphY: -14, badge: glyphs.plus, badgeStroke: true, title: "Road Trip", titleSize: 15, titleColor: MUTED }),
  device: keySvg({ glyph: glyphs.device, glyphStroke: true, glyphColor: GREEN, glyphScale: 0.5, glyphY: -14, title: "Office PC", titleSize: 15, titleColor: GREEN, ring: GREEN }),
  seek: keySvg({ glyph: glyphs.seekFwd, glyphStroke: true, glyphScale: 0.6, label: "15", labelSize: 30 }),
};

const icon = readFileSync(join(out, "app-icon-288.png")).toString("base64");

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:960px;overflow:hidden;background:#0f0f0f;font-family:"Segoe UI",Helvetica,Arial,sans-serif;color:#fff}
  .bg{position:absolute;inset:0;background:radial-gradient(1200px 700px at 30% 40%,#163d24 0%,#0f0f0f 60%)}
  .wrap{position:relative;width:1920px;height:960px}
  h1{font-size:96px;font-weight:800;margin:0;letter-spacing:-2px}
  h2{font-size:64px;font-weight:800;margin:0 0 18px;letter-spacing:-1px}
  p{font-size:34px;color:#b3b3b3;margin:0;line-height:1.35}
  .green{color:#1db954}
  .row{display:flex;gap:28px}
  .col{display:flex;flex-direction:column;gap:28px}
  .strip{width:400px;height:200px;background:#000;border-radius:22px;border:6px solid #2a2a2a;display:flex;align-items:center;padding:0 10px;box-sizing:border-box;gap:12px}
  .strip .t{font-size:30px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .strip .a{font-size:24px;color:#b3b3b3}
  .strip .time{font-size:22px;color:#8a8a8a;margin-top:6px}
  .bar{height:20px;background:#3a3a3a;border-radius:4px;margin-top:10px;overflow:hidden}
  .bar i{display:block;height:100%;background:#1db954;width:42%}
  .dial{width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#3a3a3a,#111 70%);border:4px solid #333;margin:0 auto}
  .feature{display:flex;gap:22px;align-items:flex-start}
  .feature .dot{width:18px;height:18px;border-radius:50%;background:#1db954;margin-top:16px;flex:none}
  .feature b{font-size:36px;display:block;margin-bottom:6px}
  .feature span{font-size:28px;color:#b3b3b3;line-height:1.35}
</style></head><body><div class="wrap"><div class="bg"></div>${body}</div></body></html>`;

const deck = (list, size = 150) => `<div class="col">${[0, 1].map((r) => `<div class="row">${list.slice(r * 4, r * 4 + 4).map((k) => img(k, size)).join("")}</div>`).join("")}</div>`;

const pages = {
  "thumbnail.html": page(`
    <div style="position:absolute;left:120px;top:150px;width:900px">
      <div style="display:flex;align-items:center;gap:36px;margin-bottom:40px"><img src="data:image/png;base64,${icon}" width="160" height="160" style="border-radius:36px"><h1>Simply<br>Spotify</h1></div>
      <p>Spotify on your Stream Deck, done right. Live album art, a Like button that knows, dials that just work.</p>
    </div>
    <div style="position:absolute;right:120px;top:140px">${deck([keys.nowPlaying, keys.liked, keys.shuffleOn, keys.next, keys.playing, keys.volume, keys.playlist, keys.repeatOne], 160)}</div>
    <div style="position:absolute;right:120px;bottom:90px" class="strip">
      <img src="${ART[0]}" width="150" height="150" style="border-radius:8px">
      <div style="flex:1;min-width:0"><div class="t">Midnight City</div><div class="a">M83</div><div class="time">1:41 / 4:03</div><div class="bar"><i></i></div></div>
    </div>`),

  "gallery-1.html": page(`
    <div style="position:absolute;left:120px;top:120px;width:760px">
      <h2>Live on every key</h2>
      <p>Album art on Play/Pause and Now Playing. Heart, shuffle and repeat show the real state the moment it changes, and every key reads from one shared, rate-limit-friendly connection to Spotify.</p>
    </div>
    <div style="position:absolute;right:120px;top:120px">${deck([keys.nowPlaying, keys.playing, keys.liked, keys.unliked, keys.shuffleOn, keys.repeatOne, keys.prev, keys.next], 170)}</div>
    <div style="position:absolute;left:120px;bottom:110px" class="row">${[keys.volume, keys.seek, keys.playlist, keys.addTo, keys.device].map((k) => img(k, 140)).join("")}</div>`),

  "gallery-2.html": page(`
    <div style="position:absolute;left:120px;top:120px;width:760px">
      <h2>Built for Stream Deck +</h2>
      <p>The touch strip becomes a now-playing display with art, title, artist and progress. Twist a dial for volume or to scrub through the track. Press for play/pause, tap for next, hold for like.</p>
    </div>
    <div style="position:absolute;right:120px;top:160px" class="col">
      <div class="row">
        <div class="strip"><img src="${ART[0]}" width="150" height="150" style="border-radius:8px"><div style="flex:1;min-width:0"><div class="t">♥ Midnight City</div><div class="a">M83</div><div class="time">1:41 / 4:03</div><div class="bar"><i></i></div></div></div>
        <div class="strip"><img src="${ART[2]}" width="150" height="150" style="border-radius:8px"><div style="flex:1;min-width:0"><div class="t">Golden Hour</div><div class="a">JVKE</div><div class="time">Volume 57%</div><div class="bar"><i style="width:57%"></i></div></div></div>
      </div>
      <div class="row" style="justify-content:space-around;padding:0 60px"><div class="dial"></div><div class="dial"></div><div class="dial"></div><div class="dial"></div></div>
      <div class="row" style="justify-content:space-around;padding:0 20px;color:#8a8a8a;font-size:24px"><span>Volume</span><span>Scrub</span><span>Now Playing</span><span>Volume</span></div>
    </div>`),

  "gallery-3.html": page(`
    <div style="position:absolute;left:120px;top:110px;width:840px">
      <h2 style="font-size:60px">Two-minute setup,<br>then it just works</h2>
      <div class="col" style="gap:26px;margin-top:24px">
        <div class="feature"><div class="dot"></div><div><b>Your own Spotify app</b><span>Create a free app in Spotify's developer dashboard, paste the Client ID, click Connect. No secrets, no third-party servers.</span></div></div>
        <div class="feature"><div class="dot"></div><div><b>Polite polling</b><span>One shared monitor, sensible intervals, automatic token refresh and back-off. No more keys that quietly stop updating.</span></div></div>
        <div class="feature"><div class="dot"></div><div><b>Playlists and devices</b><span>Start any playlist or link, add the current track to a playlist without duplicates, move playback between devices.</span></div></div>
        <div class="feature"><div class="dot"></div><div><b>Free and open source</b><span>MIT licensed on GitHub. Spotify Premium required for playback control.</span></div></div>
      </div>
    </div>
    <div style="position:absolute;right:120px;top:190px">${deck([keys.playlist, keys.addTo, keys.device, keys.volume, keys.nowPlaying2, keys.seek, keys.liked, keys.playing], 160)}</div>`),
};

const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!browser) throw new Error("No Edge/Chrome found for headless rendering");

for (const [name, html] of Object.entries(pages)) {
  const htmlPath = join(tmp, name);
  writeFileSync(htmlPath, html);
  const png = join(out, name.replace(".html", ".png"));
  const r = spawnSync(browser, ["--headless=new", `--user-data-dir=${join(tmp, "profile-" + name.replace(".html", ""))}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1920,960", `--screenshot=${png}`, pathToFileURL(htmlPath).href], { stdio: "ignore", timeout: 60000 });
  if (r.status !== 0 || !existsSync(png)) throw new Error(`Rendering ${name} failed (status ${r.status})`);
  console.log("wrote", png);
}
