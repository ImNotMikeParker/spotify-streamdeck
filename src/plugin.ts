import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { AddToPlaylist, PlayUri, PlaybackDevice, Seek, Volume, normalizeUri } from "./actions/controls";
import { NowPlayingDial, SeekDial, VolumeDial } from "./actions/dials";
import { Like, Next, NowPlaying, PlayPause, Previous, Repeat, Shuffle } from "./actions/playback";
import { auth, describeError, player } from "./spotify";
import { catalog } from "./spotify/catalog";

streamDeck.logger.setLevel("info");
const logger = streamDeck.logger.createScope("plugin");

// Register every action.
for (const a of [
  new PlayPause(),
  new NowPlaying(),
  new Next(),
  new Previous(),
  new Like(),
  new Shuffle(),
  new Repeat(),
  new Volume(),
  new Seek(),
  new PlayUri(),
  new AddToPlaylist(),
  new PlaybackDevice(),
  new NowPlayingDial(),
  new SeekDial(),
  new VolumeDial(),
]) {
  streamDeck.actions.registerAction(a);
}

// ---------------------------------------------------------------------------
// Property inspector messaging (shared by every action's UI)
// ---------------------------------------------------------------------------

type PiMessage =
  | { event: "get-auth-status" }
  | { event: "connect"; clientId: string; port?: number }
  | { event: "disconnect" }
  | { event: "getPlaylists"; isRefresh?: boolean }
  | { event: "getDevices"; isRefresh?: boolean }
  | { event: "resolve-uri"; uri: string };

function sendToPi(payload: JsonValue): void {
  streamDeck.ui.sendToPropertyInspector(payload).catch((e) => logger.warn(`sendToPropertyInspector failed: ${e}`));
}

function sendAuthStatus(): void {
  sendToPi({ event: "auth-status", ...auth.status(), stats: player.stats() });
}

auth.on("status", sendAuthStatus);
streamDeck.ui.onDidAppear(() => sendAuthStatus());
// Keep the call counter in the open settings panel fresh without spamming: once every 10 s while a PI is open.
setInterval(() => {
  if (streamDeck.ui.action) sendAuthStatus();
}, 10_000);

streamDeck.ui.onSendToPlugin<JsonValue>(async (ev) => {
  const msg = ev.payload as PiMessage;
  if (!msg || typeof msg !== "object" || !("event" in msg)) return;
  try {
    switch (msg.event) {
      case "get-auth-status":
        sendAuthStatus();
        break;
      case "connect":
        await auth.connect(msg.clientId ?? "", msg.port ? Number(msg.port) : undefined);
        break;
      case "disconnect":
        await auth.disconnect();
        break;
      case "getPlaylists": {
        const lists = await catalog.getPlaylists(!!msg.isRefresh);
        sendToPi({
          event: "getPlaylists",
          items: lists.length
            ? lists.map((p) => ({ label: `${p.name}${p.owner ? ` · ${p.owner}` : ""}`, value: p.uri }))
            : [{ label: auth.isConnected ? "No playlists found" : "Connect to Spotify first", value: "", disabled: true }],
        });
        break;
      }
      case "getDevices": {
        const devices = auth.isConnected ? await catalog.getDevices() : [];
        sendToPi({
          event: "getDevices",
          items: devices.length
            ? devices.map((d) => ({ label: `${d.name} (${d.type})${d.isActive ? " · active" : ""}`, value: catalog.deviceValue(d) }))
            : [{ label: auth.isConnected ? "No devices online. Open Spotify somewhere and refresh." : "Connect to Spotify first", value: "", disabled: true }],
        });
        break;
      }
      case "resolve-uri":
        sendToPi({ event: "resolve-uri", uri: normalizeUri(msg.uri) });
        break;
    }
  } catch (e) {
    logger.warn(`PI request ${msg.event} failed: ${describeError(e)}`);
    if (msg.event === "getPlaylists" || msg.event === "getDevices") {
      sendToPi({ event: msg.event, items: [{ label: describeError(e), value: "", disabled: true }] });
    }
    sendAuthStatus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

streamDeck.system.onSystemDidWakeUp(() => player.refreshSoon(2000));

await streamDeck.connect();
await auth.init();
logger.info(`Simply Spotify ready (connected=${auth.isConnected})`);
if (streamDeck.actions.length > 0) player.start();
