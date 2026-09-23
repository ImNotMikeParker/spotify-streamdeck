/** Generates the property-inspector pages in com.mjp.spotifydeck.sdPlugin/ui from one template. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "com.mjp.spotifydeck.sdPlugin", "ui");

const head = (title) => `<!DOCTYPE html>
<html>
<head lang="en">
  <meta charset="utf-8" />
  <title>${title}</title>
  <script src="https://sdpi-components.dev/releases/v4/sdpi-components.js"></script>
  <link rel="stylesheet" href="common.css" />
  <script src="common.js"></script>
</head>
<body>
  <div id="account"></div>
  <hr />
`;
const foot = `</body>
</html>
`;

const opts = (list, def) =>
  list
    .map((o) => {
      const [v, l] = o.split("|");
      return `      <option value="${v}"${v === def ? " selected" : ""}>${l}</option>`;
    })
    .join("\n");
const TAP = ["play-pause|Play / pause", "next|Next track", "previous|Previous track", "like|Like / unlike", "mute|Mute / unmute", "none|Nothing"];
const PRESS = ["play-pause|Play / pause", "next|Next track", "previous|Previous track", "like|Like / unlike", "none|Nothing"];

const select = (label, setting, list, def) => `  <sdpi-item label="${label}">
    <sdpi-select setting="${setting}" default="${def}">
${opts(list, def)}
    </sdpi-select>
  </sdpi-item>
`;
const check = (label, setting, text, def) => `  <sdpi-item label="${label}">
    <sdpi-checkbox setting="${setting}"${def ? ` default="true"` : ""} label="${text}"></sdpi-checkbox>
  </sdpi-item>
`;
const range = (label, setting, min, max, step, def) => `  <sdpi-item label="${label}">
    <sdpi-range setting="${setting}" min="${min}" max="${max}" step="${step}" default="${def}" showlabels></sdpi-range>
  </sdpi-item>
`;
const help = (text) => `  <div class="sd-help">${text}</div>\n`;
const playlistSelect = `  <sdpi-item label="Playlist">
    <sdpi-select setting="playlistUri" datasource="getPlaylists" loading="Loading your playlists…" show-refresh placeholder="Choose a playlist"></sdpi-select>
  </sdpi-item>
`;

const pages = {
  "simple.html": "",

  "play-pause.html":
    check("Album art", "showArt", "Show album art behind the button", true) +
    check("Progress", "showProgress", "Show a progress bar", true) +
    select("Long press", "longPress", PRESS.filter((o) => !o.startsWith("play-pause")), "next") +
    help("Tip: if you never long-press, choose Nothing so a normal press fires the instant you touch the key."),

  "now-playing.html":
    select("Press", "press", PRESS, "play-pause") +
    select("Long press", "longPress", PRESS, "like") +
    check("Text", "showText", "Show track and artist", true) +
    check("Progress", "showProgress", "Show a progress bar", true),

  "previous.html": check("Behaviour", "smart", "Restart the track when more than 3 s in (like the Spotify app)", true),

  "like.html":
    check("Label", "showTitle", "Show Like / Liked text under the heart", false) +
    help("The heart fills green when the current track is already in Liked Songs and re-checks the moment the track changes. Press to toggle. In a Multi Action you can force Like or Unlike."),

  "volume.html":
    select("Action", "mode", ["up|Volume up", "down|Volume down", "mute|Mute / unmute", "set|Set to a level"], "up") +
    range("Step", "step", 1, 50, 1, 10) +
    range("Level", "level", 0, 100, 5, 50) +
    help("Step applies to up/down; Level applies to Set. Volume needs a device that supports it (the desktop app does, some Connect speakers do not)."),

  "seek.html":
    `  <sdpi-item label="Seconds">
    <sdpi-textfield setting="seconds" type="number" default="10" placeholder="10"></sdpi-textfield>
  </sdpi-item>
` + help("Positive jumps forward, negative jumps back (for example -15)."),

  "play-uri.html":
    `  <sdpi-item label="Source">
    <sdpi-radio setting="source" default="playlist" columns="2">
      <option value="playlist">My playlists</option>
      <option value="uri">Link / URI</option>
    </sdpi-radio>
  </sdpi-item>
` +
    playlistSelect +
    `  <sdpi-item label="Link / URI">
    <sdpi-textfield setting="uri" placeholder="https://open.spotify.com/album/… or spotify:playlist:…"></sdpi-textfield>
  </sdpi-item>
` +
    select("Shuffle", "shuffle", ["keep|Leave as is", "on|Turn on", "off|Turn off"], "keep") +
    `  <sdpi-item label="Label">
    <sdpi-textfield setting="label" placeholder="Optional name shown on the key"></sdpi-textfield>
  </sdpi-item>
` +
    help("Works with playlists, albums, artists, tracks, podcasts and episodes. Paste a share link straight from Spotify. The key turns green while that playlist or album is playing."),

  "add-to-playlist.html":
    playlistSelect +
    check("Duplicates", "allowDuplicates", "Allow adding a track that is already in the playlist", false) +
    help("Only playlists you can edit will accept tracks. Podcast episodes cannot be added."),

  "device.html":
    `  <sdpi-item label="Device">
    <sdpi-select setting="device" datasource="getDevices" loading="Looking for devices…" show-refresh placeholder="Choose a device"></sdpi-select>
  </sdpi-item>
` + help("Only devices currently online in Spotify are listed. Open Spotify on the device and hit refresh if it is missing. If Spotify later changes the device id, the key falls back to matching by name."),

  "dial-now-playing.html":
    select("Rotate", "rotate", ["volume|Volume", "seek|Scrub through the track"], "volume") +
    range("Volume step", "volumeStep", 1, 20, 1, 5) +
    range("Scrub step (s)", "seekStep", 1, 30, 1, 5) +
    select("Press dial", "press", TAP, "play-pause") +
    select("Tap screen", "tap", TAP, "next") +
    select("Long tap", "longTap", TAP, "like"),

  "dial-seek.html":
    select("Rotate", "rotate", ["seek|Scrub through the track", "volume|Volume"], "seek") +
    range("Scrub step (s)", "seekStep", 1, 30, 1, 5) +
    range("Volume step", "volumeStep", 1, 20, 1, 5) +
    select("Press dial", "press", TAP, "play-pause") +
    select("Tap screen", "tap", TAP, "next") +
    select("Long tap", "longTap", TAP, "previous"),

  "dial-volume.html":
    range("Step per tick", "step", 1, 20, 1, 5) +
    select("Press dial", "press", TAP, "mute") +
    select("Tap screen", "tap", TAP, "play-pause") +
    select("Long tap", "longTap", TAP, "next"),
};

for (const [name, body] of Object.entries(pages)) {
  const title = name.replace(".html", "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  writeFileSync(join(uiDir, name), head(title === "Simple" ? "Simply Spotify" : title) + body + foot);
}
console.log(`${Object.keys(pages).length} property inspector pages written`);
