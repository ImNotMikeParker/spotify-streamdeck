/** Renders square profile pictures for the "Simple Plugins" Maker organization into assets/org/ (1024 px PNG). */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "assets/org");
mkdirSync(out, { recursive: true });
const tmp = join(tmpdir(), "simple-plugins-avatar");
mkdirSync(tmp, { recursive: true });

const SIZE = 1024;
const page = (body, bg = "#141414") => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:${bg};font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#fff}
  .wrap{position:relative;width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center}
</style></head><body><div class="wrap">${body}</div></body></html>`;

const GREEN = "#1db954";

const variants = {
  // A: bold "SP" monogram, the P's counter replaced by a green key tile.
  "simple-plugins-monogram": page(`
    <div style="position:absolute;inset:0;background:radial-gradient(700px 700px at 30% 25%,#1f2a22 0%,#141414 65%)"></div>
    <div style="position:relative;display:flex;align-items:flex-end;gap:0;line-height:1">
      <span style="font-size:560px;font-weight:800;letter-spacing:-30px">S</span>
      <span style="font-size:560px;font-weight:800;letter-spacing:-30px;margin-left:-10px">P</span>
      <span style="position:absolute;right:-8px;bottom:-6px;width:120px;height:120px;border-radius:26px;background:${GREEN};box-shadow:0 0 40px ${GREEN}88"></span>
    </div>`),

  // B: a 2x2 grid of Stream Deck style keys, one lit green, no text (reads well at tiny sizes).
  "simple-plugins-keys": page(`
    <div style="position:absolute;inset:0;background:radial-gradient(700px 700px at 30% 25%,#1f2a22 0%,#141414 65%)"></div>
    <div style="position:relative;display:grid;grid-template-columns:repeat(2,300px);gap:56px">
      <div style="width:300px;height:300px;border-radius:64px;background:#2a2a2a;border:10px solid #3a3a3a;box-sizing:border-box"></div>
      <div style="width:300px;height:300px;border-radius:64px;background:${GREEN};border:10px solid ${GREEN};box-sizing:border-box;box-shadow:0 0 80px ${GREEN}66;display:flex;align-items:center;justify-content:center">
        <div style="width:0;height:0;border-left:110px solid #0f0f0f;border-top:70px solid transparent;border-bottom:70px solid transparent;margin-left:24px"></div>
      </div>
      <div style="width:300px;height:300px;border-radius:64px;background:#2a2a2a;border:10px solid #3a3a3a;box-sizing:border-box"></div>
      <div style="width:300px;height:300px;border-radius:64px;background:#2a2a2a;border:10px solid #3a3a3a;box-sizing:border-box"></div>
    </div>`),

  // C: monogram on a green tile, dark letters (inverse, high contrast on any background).
  "simple-plugins-green-tile": page(`
    <div style="position:relative;width:820px;height:820px;border-radius:190px;background:linear-gradient(160deg,#1ed760,#169c46);display:flex;align-items:center;justify-content:center;box-shadow:0 30px 80px #000a">
      <span style="font-size:470px;font-weight:800;letter-spacing:-22px;color:#0f0f0f;line-height:1;margin-top:-20px">SP</span>
    </div>`, "#0f0f0f"),
};

const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!browser) throw new Error("No Chrome/Edge found");

for (const [name, html] of Object.entries(variants)) {
  const htmlPath = join(tmp, `${name}.html`);
  writeFileSync(htmlPath, html);
  const png = join(out, `${name}.png`);
  const r = spawnSync(
    browser,
    ["--headless=new", `--user-data-dir=${join(tmp, "profile-" + name)}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${SIZE},${SIZE}`, `--screenshot=${png}`, pathToFileURL(htmlPath).href],
    { stdio: "ignore", timeout: 60000 },
  );
  if (r.status !== 0 || !existsSync(png)) throw new Error(`Rendering ${name} failed`);
  console.log("wrote", png);
}
