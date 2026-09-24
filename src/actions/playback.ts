import { action } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { GREEN, MUTED, glyphs, keyImage, notConnectedImage } from "../render/svg";
import { auth, player } from "../spotify";
import { formatClock, isLikeable } from "../spotify/player";
import { SpotifyAction, desiredState, type AnyAction } from "./base";

// ---------------------------------------------------------------------------
// Play / Pause
// ---------------------------------------------------------------------------

type PlayPauseSettings = { showArt?: boolean; showProgress?: boolean; longPress?: "none" | "next" | "previous" | "like" };

@action({ UUID: "com.mjp.spotifydeck.play-pause" })
export class PlayPause extends SpotifyAction<PlayPauseSettings> {
  protected override rendersProgress = true;
  protected override supportsLongPress = true;

  protected override async render(a: AnyAction<PlayPauseSettings>, s: PlayPauseSettings): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.play));
    const st = player.state;
    const playing = !!st?.isPlaying;
    const showArt = s.showArt !== false;
    const dur = st?.track?.durationMs ?? 0;
    await a.setImage(
      keyImage({
        art: showArt ? player.art : null,
        dim: playing ? 0.3 : 0.55,
        glyph: playing ? glyphs.pause : glyphs.play,
        glyphScale: 0.62,
        progress: s.showProgress !== false && dur > 0 ? player.progressMs / dur : null,
      }),
    );
  }

  protected override async onPress(): Promise<void> {
    await player.togglePlay();
  }

  protected override async onLongPress(_a: AnyAction<PlayPauseSettings>, s: PlayPauseSettings): Promise<void> {
    switch (s.longPress ?? "next") {
      case "next":
        return player.next();
      case "previous":
        return player.previous(0);
      case "like":
        await player.toggleLiked();
        return;
      default:
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Now Playing (key)
// ---------------------------------------------------------------------------

type PressAction = "play-pause" | "next" | "previous" | "like" | "none";
type NowPlayingSettings = { press?: PressAction; longPress?: PressAction; showText?: boolean; showProgress?: boolean };

async function runPressAction(kind: PressAction | undefined, fallback: PressAction): Promise<void> {
  switch (kind ?? fallback) {
    case "play-pause":
      return player.togglePlay();
    case "next":
      return player.next();
    case "previous":
      return player.previous();
    case "like":
      await player.toggleLiked();
      return;
    default:
      return;
  }
}

@action({ UUID: "com.mjp.spotifydeck.now-playing" })
export class NowPlaying extends SpotifyAction<NowPlayingSettings> {
  protected override rendersProgress = true;
  protected override supportsLongPress = true;

  protected override async render(a: AnyAction<NowPlayingSettings>, s: NowPlayingSettings): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.spotify));
    const st = player.state;
    const t = st?.track;
    if (!t) {
      const limited = player.isLimited;
      return a.setImage(
        keyImage({
          glyph: glyphs.spotify,
          glyphColor: "#333",
          glyphScale: 0.5,
          glyphY: -12,
          title: limited ? "Quota" : player.error ? "Offline" : "Nothing",
          subtitle: limited ? `until ${formatClock(player.limitedUntil!)}` : player.error ? "check settings" : "playing",
          titleColor: limited ? "#e5a53a" : MUTED,
        }),
      );
    }
    const showText = s.showText !== false;
    const dur = t.durationMs;
    await a.setImage(
      keyImage({
        art: player.art,
        dim: st?.isPlaying ? (showText ? 0.15 : 0) : 0.5,
        glyph: st?.isPlaying ? undefined : glyphs.pause,
        glyphScale: 0.35,
        glyphY: showText ? -14 : 0,
        badge: player.liked ? glyphs.heart : undefined,
        title: showText ? t.name : undefined,
        subtitle: showText ? t.artists : undefined,
        titleSize: 16,
        progress: s.showProgress !== false && dur > 0 ? player.progressMs / dur : null,
      }),
    );
  }

  protected override async onPress(_a: AnyAction<NowPlayingSettings>, s: NowPlayingSettings): Promise<void> {
    await runPressAction(s.press, "play-pause");
  }

  protected override async onLongPress(_a: AnyAction<NowPlayingSettings>, s: NowPlayingSettings): Promise<void> {
    await runPressAction(s.longPress, "like");
  }
}

// ---------------------------------------------------------------------------
// Next / Previous
// ---------------------------------------------------------------------------

@action({ UUID: "com.mjp.spotifydeck.next" })
export class Next extends SpotifyAction<JsonObject> {
  protected override async render(a: AnyAction<JsonObject>): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.next));
    await a.setImage(keyImage({ glyph: glyphs.next, glyphScale: 0.6, opacity: player.state?.track ? 1 : 0.5 }));
  }
  protected override async onPress(): Promise<void> {
    await player.next();
  }
}

type PreviousSettings = { smart?: boolean };

@action({ UUID: "com.mjp.spotifydeck.previous" })
export class Previous extends SpotifyAction<PreviousSettings> {
  protected override async render(a: AnyAction<PreviousSettings>): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.previous));
    await a.setImage(keyImage({ glyph: glyphs.previous, glyphScale: 0.6, opacity: player.state?.track ? 1 : 0.5 }));
  }
  protected override async onPress(_a: AnyAction<PreviousSettings>, s: PreviousSettings): Promise<void> {
    await player.previous(s.smart === false ? 0 : 3000);
  }
}

// ---------------------------------------------------------------------------
// Like
// ---------------------------------------------------------------------------

type LikeSettings = { showTitle?: boolean };

@action({ UUID: "com.mjp.spotifydeck.like" })
export class Like extends SpotifyAction<LikeSettings> {
  protected override async render(a: AnyAction<LikeSettings>, s: LikeSettings): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.heart));
    const t = player.state?.track;
    const likeable = isLikeable(t);
    const liked = likeable && player.liked;
    const showTitle = s.showTitle === true;
    await a.setImage(
      keyImage({
        glyph: glyphs.heart,
        glyphStroke: !liked,
        glyphColor: liked ? GREEN : likeable ? "#ffffff" : "#555",
        glyphScale: showTitle ? 0.5 : 0.6,
        glyphY: showTitle ? -12 : 0,
        title: showTitle ? (liked ? "Liked" : likeable ? "Like" : "—") : undefined,
        titleColor: liked ? GREEN : MUTED,
        opacity: likeable ? 1 : 0.6,
      }),
    );
  }

  protected override async onPress(a: AnyAction<LikeSettings>, _s: LikeSettings, ev: Parameters<NonNullable<SpotifyAction["onPress"]>>[2]): Promise<void> {
    const want = desiredState(ev);
    if (want === 1) await player.setLiked(true);
    else if (want === 2) await player.setLiked(false);
    else await player.toggleLiked();
    if (a.isKey()) await a.showOk();
  }
}

// ---------------------------------------------------------------------------
// Shuffle / Repeat
// ---------------------------------------------------------------------------

@action({ UUID: "com.mjp.spotifydeck.shuffle" })
export class Shuffle extends SpotifyAction<JsonObject> {
  protected override async render(a: AnyAction<JsonObject>): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.shuffle, true));
    const on = !!player.state?.shuffle;
    await a.setImage(keyImage({ glyph: glyphs.shuffle, glyphStroke: true, glyphColor: on ? GREEN : "#8a8a8a", glyphScale: 0.6, badge: on ? glyphs.check : undefined, badgeStroke: true }));
  }
  protected override async onPress(_a: AnyAction<JsonObject>, _s: JsonObject, ev: Parameters<NonNullable<SpotifyAction["onPress"]>>[2]): Promise<void> {
    const want = desiredState(ev);
    const target = want === 1 ? true : want === 2 ? false : !player.state?.shuffle;
    await player.setShuffle(target);
  }
}

@action({ UUID: "com.mjp.spotifydeck.repeat" })
export class Repeat extends SpotifyAction<JsonObject> {
  protected override async render(a: AnyAction<JsonObject>): Promise<void> {
    if (!auth.isConnected) return a.setImage(notConnectedImage(glyphs.repeat, true));
    const mode = player.state?.repeat ?? "off";
    await a.setImage(
      keyImage({
        glyph: glyphs.repeat,
        glyphStroke: true,
        glyphColor: mode === "off" ? "#8a8a8a" : GREEN,
        glyphScale: 0.6,
        badgeText: mode === "track" ? "1" : undefined,
      }),
    );
  }
  protected override async onPress(_a: AnyAction<JsonObject>, _s: JsonObject, ev: Parameters<NonNullable<SpotifyAction["onPress"]>>[2]): Promise<void> {
    const want = desiredState(ev);
    const cycle = { off: "context", context: "track", track: "off" } as const;
    const target = want === 1 ? "off" : want === 2 ? "context" : want === 3 ? "track" : cycle[player.state?.repeat ?? "off"];
    await player.setRepeat(target);
  }
}
