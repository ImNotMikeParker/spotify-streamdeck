import { action, type DialAction, type DialDownEvent, type DialRotateEvent, type TouchTapEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { GREEN, formatTime, glyphs, iconSvg } from "../render/svg";
import { auth, player } from "../spotify";
import { SpotifyAction, type AnyAction } from "./base";

type TapAction = "next" | "previous" | "play-pause" | "like" | "mute" | "none";
type RotateMode = "volume" | "seek";

async function runTap(kind: TapAction): Promise<void> {
  switch (kind) {
    case "next":
      return player.next();
    case "previous":
      return player.previous();
    case "play-pause":
      return player.togglePlay();
    case "like":
      await player.toggleLiked();
      return;
    case "mute":
      return player.toggleMute();
    default:
      return;
  }
}

const VOLUME_ICON = iconSvg(glyphs.volume + " " + glyphs.volumeWaves);
const MUTE_ICON = iconSvg(glyphs.mute, "#e5484d");
const SPOTIFY_ICON = iconSvg(glyphs.spotify, "#333");

/**
 * Shared behaviour for the two "now playing" style dials (Now Playing, Scrub): the touch strip shows art, track,
 * artist, elapsed / total and a progress bar. Rotation is volume or scrubbing depending on settings.
 */
type NowPlayingDialSettings = {
  rotate?: RotateMode;
  volumeStep?: number;
  seekStep?: number;
  press?: TapAction;
  tap?: TapAction;
  longTap?: TapAction;
};

abstract class NowPlayingDialBase extends SpotifyAction<NowPlayingDialSettings> {
  protected override rendersProgress = true;
  protected abstract defaults: Required<Pick<NowPlayingDialSettings, "rotate" | "press" | "tap" | "longTap">>;

  private lastArt = new Map<string, string | null>();
  private overlayUntil = new Map<string, { until: number; text: string }>();

  protected override async render(a: AnyAction<NowPlayingDialSettings>, _s: NowPlayingDialSettings): Promise<void> {
    if (!a.isDial()) return;
    if (!auth.isConnected) {
      await a.setFeedback({ art: SPOTIFY_ICON, track: "Not connected", artist: "Open settings", time: "and click Connect", bar: 0 });
      this.lastArt.set(a.id, null);
      return;
    }
    const st = player.state;
    const t = st?.track;
    if (!t) {
      await a.setFeedback({ art: SPOTIFY_ICON, track: player.error ? "Spotify offline" : "Nothing playing", artist: player.error ?? "", time: "", bar: 0 });
      this.lastArt.set(a.id, null);
      return;
    }
    const art = player.art ?? SPOTIFY_ICON;
    const overlay = this.overlayUntil.get(a.id);
    const showOverlay = overlay && Date.now() < overlay.until;
    const dur = t.durationMs;
    const pos = player.progressMs;
    const feedback: Record<string, string | number> = {
      track: (player.liked ? "♥ " : "") + t.name,
      artist: t.artists,
      time: showOverlay ? overlay.text : dur ? `${formatTime(pos)} / ${formatTime(dur)}${st?.isPlaying ? "" : "  ❚❚"}` : st?.isPlaying ? "Playing" : "Paused",
      bar: dur ? Math.round((1000 * pos) / dur) : 0,
    };
    // Only resend the (large) art payload when it changes.
    if (this.lastArt.get(a.id) !== art) {
      feedback.art = art;
      this.lastArt.set(a.id, art);
    }
    await a.setFeedback(feedback);
  }

  override onWillDisappear(ev: Parameters<SpotifyAction<NowPlayingDialSettings>["onWillDisappear"]>[0]): void {
    this.lastArt.delete(ev.action.id);
    this.overlayUntil.delete(ev.action.id);
    super.onWillDisappear(ev);
  }

  private flash(a: DialAction<NowPlayingDialSettings>, text: string): void {
    this.overlayUntil.set(a.id, { until: Date.now() + 1200, text });
    setTimeout(() => void this.renderAll(), 1300);
  }

  override async onDialRotate(ev: DialRotateEvent<NowPlayingDialSettings>): Promise<void> {
    const s = ev.payload.settings ?? {};
    this.settingsById.set(ev.action.id, s);
    if (!auth.isConnected) return ev.action.showAlert();
    const mode = s.rotate ?? this.defaults.rotate;
    if (mode === "volume") {
      const step = Number(s.volumeStep) || 5;
      player.volumeBy(ev.payload.ticks * step);
      const v = player.volume;
      this.flash(ev.action, v === null ? "Volume: unknown" : `Volume ${v}%`);
    } else {
      const step = (Number(s.seekStep) || 5) * 1000;
      player.seekBy(ev.payload.ticks * step);
    }
    await this.render(ev.action, s);
  }

  override async onDialDown(ev: DialDownEvent<NowPlayingDialSettings>): Promise<void> {
    const s = ev.payload.settings ?? {};
    await this.guard(ev.action, () => runTap(s.press ?? this.defaults.press));
  }

  override async onTouchTap(ev: TouchTapEvent<NowPlayingDialSettings>): Promise<void> {
    const s = ev.payload.settings ?? {};
    const kind = ev.payload.hold ? (s.longTap ?? this.defaults.longTap) : (s.tap ?? this.defaults.tap);
    const ok = await this.guard(ev.action, () => runTap(kind));
    if (ok && kind === "like") this.flash(ev.action, player.liked ? "Added to Liked Songs" : "Removed from Liked Songs");
  }
}

@action({ UUID: "com.mjp.spotifydeck.dial-now-playing" })
export class NowPlayingDial extends NowPlayingDialBase {
  protected defaults = { rotate: "volume" as RotateMode, press: "play-pause" as TapAction, tap: "next" as TapAction, longTap: "like" as TapAction };
}

@action({ UUID: "com.mjp.spotifydeck.dial-seek" })
export class SeekDial extends NowPlayingDialBase {
  protected defaults = { rotate: "seek" as RotateMode, press: "play-pause" as TapAction, tap: "next" as TapAction, longTap: "previous" as TapAction };
}

// ---------------------------------------------------------------------------
// Volume dial ($B1 layout: title, icon, value, indicator)
// ---------------------------------------------------------------------------

type VolumeDialSettings = { step?: number; press?: TapAction; tap?: TapAction; longTap?: TapAction };

@action({ UUID: "com.mjp.spotifydeck.dial-volume" })
export class VolumeDial extends SpotifyAction<VolumeDialSettings> {
  protected override async render(a: AnyAction<VolumeDialSettings>, _s: VolumeDialSettings): Promise<void> {
    if (!a.isDial()) return;
    if (!auth.isConnected) return a.setFeedback({ title: "Spotify", icon: SPOTIFY_ICON, value: "Connect", indicator: 0 });
    const v = player.volume;
    const dev = player.state?.device;
    if (v === null) return a.setFeedback({ title: "Volume", icon: VOLUME_ICON, value: dev ? "n/a" : "—", indicator: 0 });
    const muted = v === 0;
    await a.setFeedback({
      title: dev?.name ? dev.name : "Volume",
      icon: muted ? MUTE_ICON : VOLUME_ICON,
      value: muted ? "Muted" : `${v}%`,
      indicator: { value: v, bar_fill_c: muted ? "#e5484d" : GREEN } as unknown as number,
    });
  }

  override async onDialRotate(ev: DialRotateEvent<VolumeDialSettings>): Promise<void> {
    if (!auth.isConnected) return ev.action.showAlert();
    const step = Number(ev.payload.settings?.step) || 5;
    player.volumeBy(ev.payload.ticks * step);
    await this.render(ev.action, ev.payload.settings ?? {});
  }

  override async onDialDown(ev: DialDownEvent<VolumeDialSettings>): Promise<void> {
    await this.guard(ev.action, () => runTap(ev.payload.settings?.press ?? "mute"));
  }

  override async onTouchTap(ev: TouchTapEvent<VolumeDialSettings>): Promise<void> {
    const s = ev.payload.settings ?? {};
    await this.guard(ev.action, () => runTap(ev.payload.hold ? (s.longTap ?? "next") : (s.tap ?? "play-pause")));
  }
}

