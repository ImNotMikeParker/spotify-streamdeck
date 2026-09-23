import { action } from "@elgato/streamdeck";
import { GREEN, MUTED, glyphs, keyImage, notConnectedImage } from "../render/svg";
import { auth, player } from "../spotify";
import { SpotifyAction, type AnyAction } from "./base";
import { catalog } from "../spotify/catalog";

// ---------------------------------------------------------------------------
// Volume (key)
// ---------------------------------------------------------------------------

type VolumeSettings = { mode?: "up" | "down" | "mute" | "set"; step?: number; level?: number };

@action({ UUID: "com.mjp.spotifydeck.volume" })
export class Volume extends SpotifyAction<VolumeSettings> {
  protected override async render(a: AnyAction<VolumeSettings>, s: VolumeSettings): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.volume));
    const mode = s.mode ?? "up";
    const vol = player.volume;
    const muted = vol === 0;
    const step = Number(s.step) || 10;
    let subtitle: string;
    switch (mode) {
      case "up":
        subtitle = `+${step}`;
        break;
      case "down":
        subtitle = `−${step}`;
        break;
      case "mute":
        subtitle = muted ? "Unmute" : "Mute";
        break;
      default:
        subtitle = `Set ${Number(s.level) || 50}%`;
    }
    await a.setImage(
      keyImage({
        glyph: muted ? glyphs.mute : glyphs.volume + " " + glyphs.volumeWaves,
        glyphStroke: false,
        glyphColor: muted ? "#e5484d" : "#ffffff",
        glyphScale: 0.42,
        glyphY: -26,
        title: vol === null ? "—" : `${vol}%`,
        titleSize: 22,
        titleColor: muted ? "#e5484d" : GREEN,
        subtitle,
        opacity: vol === null ? 0.6 : 1,
      }),
    );
  }

  protected override async onPress(_a: AnyAction<VolumeSettings>, s: VolumeSettings): Promise<void> {
    const step = Number(s.step) || 10;
    switch (s.mode ?? "up") {
      case "up":
        return player.setVolume((player.volume ?? 0) + step);
      case "down":
        return player.setVolume((player.volume ?? 0) - step);
      case "mute":
        return player.toggleMute();
      case "set":
        return player.setVolume(Number(s.level) || 50);
    }
  }
}

// ---------------------------------------------------------------------------
// Seek (key)
// ---------------------------------------------------------------------------

type SeekSettings = { seconds?: number };

@action({ UUID: "com.mjp.spotifydeck.seek" })
export class Seek extends SpotifyAction<SeekSettings> {
  protected override async render(a: AnyAction<SeekSettings>, s: SeekSettings): Promise<void> {
    const secs = Number(s.seconds) || 10;
    const back = secs < 0;
    if (!auth.isConnected) return a.setImage(notConnectedImage(back ? glyphs.seekBack : glyphs.seekFwd, true));
    await a.setImage(
      keyImage({
        glyph: back ? glyphs.seekBack : glyphs.seekFwd,
        glyphStroke: true,
        glyphScale: 0.6,
        label: `${Math.abs(secs)}`,
        labelSize: 30,
        opacity: player.state?.track ? 1 : 0.5,
      }),
    );
  }
  protected override async onPress(_a: AnyAction<SeekSettings>, s: SeekSettings): Promise<void> {
    const secs = Number(s.seconds) || 10;
    await player.seekTo(player.progressMs + secs * 1000);
  }
}

// ---------------------------------------------------------------------------
// Play playlist / URI
// ---------------------------------------------------------------------------

type PlayUriSettings = { source?: "playlist" | "uri"; playlistUri?: string; uri?: string; shuffle?: "keep" | "on" | "off"; label?: string };

/** Accepts spotify:… URIs and open.spotify.com links. */
export function normalizeUri(input: string | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^spotify:[a-z]+:[A-Za-z0-9]+$/.test(s)) return s;
  const m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|artist|track|show|episode)\/([A-Za-z0-9]+)/);
  if (m) return `spotify:${m[1]}:${m[2]}`;
  return null;
}

@action({ UUID: "com.mjp.spotifydeck.play-uri" })
export class PlayUri extends SpotifyAction<PlayUriSettings> {
  private target(s: PlayUriSettings): string | null {
    return (s.source ?? "playlist") === "playlist" ? normalizeUri(s.playlistUri) : normalizeUri(s.uri);
  }

  protected override async render(a: AnyAction<PlayUriSettings>, s: PlayUriSettings): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.playlist, true));
    const uri = this.target(s);
    const active = !!uri && player.state?.contextUri === uri;
    const name = s.label || (uri ? catalog.playlistName(uri) : undefined);
    const kind = uri?.split(":")[1];
    await a.setImage(
      keyImage({
        glyph: kind === "track" || kind === "episode" ? glyphs.play : glyphs.playlist,
        glyphStroke: !(kind === "track" || kind === "episode"),
        glyphColor: active ? GREEN : uri ? "#ffffff" : "#555",
        glyphScale: 0.5,
        glyphY: -14,
        title: name ?? (uri ? kind : "Pick one"),
        titleSize: 15,
        titleColor: active ? GREEN : MUTED,
        ring: active && player.state?.isPlaying ? GREEN : undefined,
      }),
    );
  }

  protected override async onPress(_a: AnyAction<PlayUriSettings>, s: PlayUriSettings): Promise<void> {
    const uri = this.target(s);
    if (!uri) throw new Error("No playlist or URI configured");
    const shuffle = s.shuffle === "on" ? true : s.shuffle === "off" ? false : undefined;
    await player.playContext(uri, { shuffle });
  }
}

// ---------------------------------------------------------------------------
// Add current track to playlist
// ---------------------------------------------------------------------------

type AddToPlaylistSettings = { playlistUri?: string; allowDuplicates?: boolean };

@action({ UUID: "com.mjp.spotifydeck.add-to-playlist" })
export class AddToPlaylist extends SpotifyAction<AddToPlaylistSettings> {
  protected override async render(a: AnyAction<AddToPlaylistSettings>, s: AddToPlaylistSettings): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.plus, true));
    const name = s.playlistUri ? catalog.playlistName(s.playlistUri) : undefined;
    const t = player.state?.track;
    await a.setImage(
      keyImage({
        glyph: glyphs.playlist,
        glyphStroke: true,
        glyphColor: s.playlistUri ? "#ffffff" : "#555",
        glyphScale: 0.5,
        glyphY: -14,
        badge: glyphs.plus,
        badgeStroke: true,
        title: name ?? (s.playlistUri ? "Playlist" : "Pick one"),
        titleSize: 15,
        titleColor: MUTED,
        opacity: t && t.type === "track" ? 1 : 0.6,
      }),
    );
  }

  protected override async onPress(a: AnyAction<AddToPlaylistSettings>, s: AddToPlaylistSettings): Promise<void> {
    const t = player.state?.track;
    if (!t || t.type !== "track") throw new Error("No track playing");
    const id = s.playlistUri?.split(":").pop();
    if (!id) throw new Error("No playlist selected");
    if (!s.allowDuplicates && (await catalog.playlistContains(id, t.uri))) {
      // Already there: that is not an error, but do tell the user.
      if (a.isKey()) await a.showOk();
      return;
    }
    await catalog.addToPlaylist(id, t.uri);
    if (a.isKey()) await a.showOk();
  }
}

// ---------------------------------------------------------------------------
// Playback device
// ---------------------------------------------------------------------------

type DeviceSettings = { device?: string };

@action({ UUID: "com.mjp.spotifydeck.device" })
export class PlaybackDevice extends SpotifyAction<DeviceSettings> {
  protected override async render(a: AnyAction<DeviceSettings>, s: DeviceSettings): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.device, true));
    const { id, name } = catalog.parseDeviceValue(s.device);
    const cur = player.state?.device;
    const active = !!cur && (cur.id === id || (!!name && cur.name === name));
    await a.setImage(
      keyImage({
        glyph: glyphs.device,
        glyphStroke: true,
        glyphColor: active ? GREEN : id ? "#ffffff" : "#555",
        glyphScale: 0.5,
        glyphY: -14,
        title: name || (id ? "Device" : "Pick one"),
        titleSize: 15,
        titleColor: active ? GREEN : MUTED,
        ring: active ? GREEN : undefined,
      }),
    );
  }

  protected override async onPress(_a: AnyAction<DeviceSettings>, s: DeviceSettings): Promise<void> {
    const { id, name } = catalog.parseDeviceValue(s.device);
    if (!id) throw new Error("No device selected");
    const devices = await player.getDevices();
    // Device ids change when Spotify is reinstalled; fall back to matching by name.
    const match = devices.find((d) => d.id === id) ?? devices.find((d) => d.name === name);
    if (!match?.id) throw new Error(`Device "${name || id}" is not available right now`);
    await player.transferTo(match.id);
  }
}
