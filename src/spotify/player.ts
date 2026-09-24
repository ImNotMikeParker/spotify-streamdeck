import streamDeck from "@elgato/streamdeck";
import { EventEmitter } from "node:events";
import { AuthError, type SpotifyAuth } from "./auth";
import { RateLimitError, SpotifyApiError, apiStats, clamp, type SpotifyClient } from "./client";
import { LocalSpotifyWatcher } from "./local";
import type { Device, PlayerState, RepeatState } from "./types";

const logger = streamDeck.logger.createScope("player");

/** Tracks and podcast episodes can be saved to the library; ads and unknown items cannot. */
export function isLikeable(t: { uri: string; type: string } | null | undefined): boolean {
  return !!t && !!t.uri && (t.type === "track" || t.type === "episode");
}

/**
 * Polling cadence. Spotify's Development Mode apps have a shared *daily* request quota (unpublished, and
 * exceeded by naive once-a-second polling), so the plugin spends calls only when something changed:
 *
 * - "local": the Spotify desktop window title is watched for free; the API is only hit on a change, plus a slow
 *   resync for volume / shuffle / repeat drift.
 * - "remote": playback is somewhere else (phone, speaker) or the watcher is unavailable; poll a bit faster.
 * - "dormant": nothing has played for a while; check rarely until a key press or a local change wakes us.
 */
const CADENCE = {
  local: { playing: 90_000, paused: 300_000 },
  remote: { playing: 10_000, paused: 45_000 },
  dormantAfterMs: 15 * 60_000,
  dormant: 10 * 60_000,
  errorMax: 5 * 60_000,
};
const TICK_MS = 1000;

export class PlayerMonitor extends EventEmitter {
  state: PlayerState | null = null;
  /** Whether the current track is in Liked Songs; null when unknown. */
  liked: boolean | null = null;
  /** Album art of the current track as a data URI (null while loading / unavailable). */
  art: string | null = null;
  /** Last error message from polling, for display; null when healthy. */
  error: string | null = null;
  /** Epoch ms until which Spotify has told us to stop calling; null when not limited. */
  limitedUntil: number | null = null;

  readonly local = new LocalSpotifyWatcher();
  /** True when the local window watcher is tracking the same playback the API reports. */
  localMode = false;

  private pollTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  private polling: Promise<void> | null = null;
  private errorStreak = 0;
  private lastPlayingAt = Date.now();
  private artCache = new Map<string, string>();
  private likedFor: string | null = null;
  private endOfTrackRefreshFor: string | null = null;
  private hasPolledOk = false;

  // Optimistic overrides so the UI does not snap back before Spotify catches up.
  private volumeOverride: { value: number; until: number } | null = null;
  private progressOverride: { value: number; until: number } | null = null;
  private volumeDebounce: NodeJS.Timeout | null = null;
  private seekDebounce: NodeJS.Timeout | null = null;
  private pendingVolume: number | null = null;
  private pendingSeek: number | null = null;
  private mutedFrom: number | null = null;

  constructor(
    private readonly api: SpotifyClient,
    private readonly auth: SpotifyAuth,
  ) {
    super();
    this.setMaxListeners(100);
    auth.on("connected", () => this.refreshSoon(0));
    auth.on("status", (s: { connected: boolean }) => {
      if (!s.connected) {
        this.state = null;
        this.liked = null;
        this.art = null;
        this.emit("update");
      }
    });
    this.local.on("change", (title: string | null) => this.onLocalChange(title));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.errorStreak = 0;
    logger.debug("Monitor started");
    this.local.start();
    void this.poll();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = this.tickTimer = null;
    this.local.stop();
    logger.debug("Monitor stopped");
  }

  /** Ask for a fresh poll shortly (after a command), coalescing multiple requests. Respects an active limit. */
  refreshSoon(delayMs = 350): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const wait = this.isLimited ? Math.max(delayMs, this.limitedUntil! - Date.now() + 500) : delayMs;
    this.pollTimer = setTimeout(() => void this.poll(), wait);
  }

  get isLimited(): boolean {
    return this.limitedUntil !== null && Date.now() < this.limitedUntil;
  }

  /** Human-readable summary for the property inspector. */
  stats(): { callsToday: number; mode: "local" | "remote" | "dormant" | "limited"; limitedUntil: number | null; watcher: boolean } {
    return {
      callsToday: apiStats.calls,
      mode: this.isLimited ? "limited" : this.isDormant ? "dormant" : this.localMode ? "local" : "remote",
      limitedUntil: this.isLimited ? this.limitedUntil : null,
      watcher: this.local.available,
    };
  }

  private get isDormant(): boolean {
    return !this.state?.isPlaying && Date.now() - this.lastPlayingAt > CADENCE.dormantAfterMs;
  }

  /** Current progress in ms, interpolated from the last sample if playing. */
  get progressMs(): number {
    const s = this.state;
    if (!s) return 0;
    if (this.progressOverride && Date.now() < this.progressOverride.until) return this.progressOverride.value;
    if (!s.isPlaying) return s.progressMs;
    const dur = s.track?.durationMs ?? 0;
    const p = s.progressMs + (Date.now() - s.sampledAt);
    return dur ? Math.min(p, dur) : p;
  }

  /** Current volume 0..100 (optimistic), or null when unknown / unsupported. */
  get volume(): number | null {
    if (this.volumeOverride && Date.now() < this.volumeOverride.until) return this.volumeOverride.value;
    return this.state?.device?.volume ?? null;
  }

  get isMuted(): boolean {
    return (this.volume ?? -1) === 0;
  }

  // ---- Scheduling -----------------------------------------------------------

  private schedule(): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    let delay: number;
    if (this.isLimited) delay = this.limitedUntil! - Date.now() + 1000;
    else if (this.errorStreak > 0) delay = Math.min(30_000 * 2 ** (this.errorStreak - 1), CADENCE.errorMax);
    else if (this.isDormant) delay = CADENCE.dormant;
    else {
      const c = this.localMode ? CADENCE.local : CADENCE.remote;
      delay = this.state?.isPlaying ? c.playing : c.paused;
    }
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.doPoll().finally(() => {
      this.polling = null;
      this.schedule();
    });
    return this.polling;
  }

  private async doPoll(): Promise<void> {
    if (!this.auth.isConnected) {
      this.error = "Not connected";
      return;
    }
    if (this.isLimited) return;
    try {
      const next = await this.api.getPlayerState();
      if (this.errorStreak > 0 || this.limitedUntil !== null || !this.hasPolledOk) {
        logger.info(`Poll ok: ${next ? (next.isPlaying ? "playing" : "paused") + " on " + (next.device?.name ?? "?") : "nothing playing"}${next?.track ? " - " + next.track.name : ""} (calls today: ${apiStats.calls})`);
        this.hasPolledOk = true;
      }
      this.errorStreak = 0;
      this.error = null;
      this.limitedUntil = null;
      const prev = this.state;
      this.state = next;
      if (next?.isPlaying) this.lastPlayingAt = Date.now();
      this.updateLocalMode();

      const trackId = next?.track?.uri ?? null;
      const prevTrackId = prev?.track?.uri ?? null;
      if (trackId !== prevTrackId) {
        this.liked = null;
        this.likedFor = null;
        this.art = null;
        this.endOfTrackRefreshFor = null;
        void this.loadArt(next?.track?.artUrl ?? null, trackId);
        void this.loadLiked(trackId);
        this.emit("track", next?.track ?? null);
      } else if (this.art === null && next?.track?.artUrl) {
        void this.loadArt(next.track.artUrl, trackId);
      }
      this.emit("update");
    } catch (e) {
      if (e instanceof RateLimitError) {
        this.limitedUntil = e.retryAt;
        this.error = `${e.quota ? "Spotify quota exceeded" : "Spotify rate limit"} until ${formatClock(e.retryAt)}`;
        logger.warn(`${this.error} (retry-after ${Math.round(e.retryAfterMs / 1000)}s)`);
      } else {
        this.errorStreak++;
        if (e instanceof AuthError || e instanceof SpotifyApiError) this.error = e.message;
        else {
          this.error = "Network error";
          logger.warn(`Poll failed: ${e}`);
        }
      }
      this.emit("update");
    }
  }

  /** Decide whether the local window watcher is describing the playback the API reports. */
  private updateLocalMode(): void {
    if (!this.local.available) {
      this.localMode = false;
      return;
    }
    const s = this.state;
    const parsed = LocalSpotifyWatcher.parse(this.local.title);
    if (s?.isPlaying && s.track) {
      this.localMode = !!parsed && sameTitle(parsed.track, s.track.name);
    } else if (s && !s.isPlaying) {
      // Paused: the desktop title goes idle, which matches. Keep local mode unless the device is clearly remote.
      this.localMode = LocalSpotifyWatcher.isIdleTitle(this.local.title) || this.localMode;
    } else {
      this.localMode = this.local.title !== null;
    }
  }

  private onLocalChange(title: string | null): void {
    if (!this.running || !this.auth.isConnected) return;
    const parsed = LocalSpotifyWatcher.parse(title);
    const s = this.state;
    if (parsed) {
      // A track title appeared: playing started or the track changed.
      const same = !!s?.track && sameTitle(parsed.track, s.track.name);
      if (!s?.isPlaying || !same) {
        logger.debug(`Local: now "${parsed.artist} - ${parsed.track}"`);
        this.refreshSoon(400);
      }
    } else if (LocalSpotifyWatcher.isIdleTitle(title) || title === null) {
      // Paused, stopped, or Spotify closed. Freeze progress immediately, then confirm with one call.
      if (s?.isPlaying && this.localMode) {
        s.progressMs = this.progressMs;
        s.sampledAt = Date.now();
        s.isPlaying = false;
        this.emit("update");
        this.refreshSoon(1500);
      } else if (title === null && s) {
        this.refreshSoon(3000);
      }
    }
  }

  private tick(): void {
    const s = this.state;
    if (!s?.isPlaying) return;
    this.emit("tick");
    // Near the end of a track, make sure we pick up the next one even if the window title does not change
    // (repeat-one, or two songs with the same name).
    const dur = s.track?.durationMs ?? 0;
    if (dur && this.progressMs >= dur - 800 && this.endOfTrackRefreshFor !== s.track?.uri) {
      this.endOfTrackRefreshFor = s.track?.uri ?? null;
      this.refreshSoon(1500);
    }
  }

  private async loadArt(url: string | null, forTrack: string | null): Promise<void> {
    if (!url) {
      this.emit("update");
      return;
    }
    try {
      let data = this.artCache.get(url);
      if (!data) {
        data = await this.api.fetchImageDataUri(url);
        this.artCache.set(url, data);
        if (this.artCache.size > 12) this.artCache.delete(this.artCache.keys().next().value!);
      }
      if ((this.state?.track?.uri ?? null) === forTrack) {
        this.art = data;
        this.emit("update");
      }
    } catch (e) {
      logger.warn(`Art load failed: ${e}`);
    }
  }

  private async loadLiked(uri: string | null): Promise<void> {
    if (!uri || !isLikeable(this.state?.track) || this.isLimited) return;
    try {
      const liked = await this.api.isSaved(uri);
      if ((this.state?.track?.uri ?? null) === uri) {
        this.liked = liked;
        this.likedFor = uri;
        this.emit("update");
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        this.limitedUntil = e.retryAt;
        this.error = `${e.quota ? "Spotify quota exceeded" : "Spotify rate limit"} until ${formatClock(e.retryAt)}`;
        this.emit("update");
      } else logger.warn(`Liked check failed: ${e}`);
    }
  }

  // ---- Commands (optimistic, coalesced where it matters) ------------------

  /** Refuse to spend calls while Spotify has us on a time-out; the key shows an alert instead. */
  private assertAvailable(): void {
    if (this.isLimited) throw new RateLimitError(this.limitedUntil! - Date.now(), true, this.error ?? "Spotify quota exceeded");
  }

  /** Makes sure something can play: if there is no active device, transfer to the best available one. */
  async ensureDevice(): Promise<string | undefined> {
    if (this.state?.device?.id) return this.state.device.id;
    const devices = await this.api.getDevices();
    if (!devices.length) throw new SpotifyApiError(404, "NO_ACTIVE_DEVICE", "No Spotify device found. Open Spotify on a device first.");
    const pick = devices.find((d) => d.isActive) ?? devices.find((d) => d.type === "Computer") ?? devices[0];
    if (!pick.id) throw new SpotifyApiError(404, "NO_ACTIVE_DEVICE", "No usable Spotify device found.");
    await this.api.transfer(pick.id, false);
    await new Promise((r) => setTimeout(r, 400));
    return pick.id;
  }

  async togglePlay(): Promise<void> {
    this.assertAvailable();
    if (this.state?.isPlaying) {
      this.state.isPlaying = false;
      this.state.progressMs = this.progressMs;
      this.state.sampledAt = Date.now();
      this.emit("update");
      await this.api.pause();
    } else {
      if (this.state) {
        this.state.isPlaying = true;
        this.state.sampledAt = Date.now();
        this.lastPlayingAt = Date.now();
        this.emit("update");
      }
      try {
        await this.api.play();
      } catch (e) {
        if (e instanceof SpotifyApiError && e.noActiveDevice) {
          const id = await this.ensureDevice();
          await this.api.play({ deviceId: id });
        } else throw e;
      }
    }
    // In local mode the window title confirms the change for free; otherwise verify with one call.
    if (!this.localMode) this.refreshSoon(600);
  }

  async next(): Promise<void> {
    this.assertAvailable();
    await this.api.next();
    this.refreshSoon(this.localMode ? 1500 : 500);
  }

  /** Spotify-app behaviour: restart the track when past the threshold, else go to the previous track. */
  async previous(restartThresholdMs = 3000): Promise<void> {
    this.assertAvailable();
    if (restartThresholdMs > 0 && this.progressMs > restartThresholdMs) {
      await this.seekTo(0);
      return;
    }
    await this.api.previous();
    this.refreshSoon(this.localMode ? 1500 : 500);
  }

  async seekTo(ms: number): Promise<void> {
    this.assertAvailable();
    const dur = this.state?.track?.durationMs ?? 0;
    const target = clamp(ms, 0, dur > 0 ? dur - 500 : Number.MAX_SAFE_INTEGER);
    this.progressOverride = { value: target, until: Date.now() + 1500 };
    if (this.state) {
      this.state.progressMs = target;
      this.state.sampledAt = Date.now();
    }
    this.emit("update");
    await this.api.seek(target);
  }

  /** Relative seek, coalesced (dial twists). */
  seekBy(deltaMs: number): void {
    if (this.isLimited) return;
    const base = this.pendingSeek ?? this.progressMs;
    const dur = this.state?.track?.durationMs ?? 0;
    const target = clamp(base + deltaMs, 0, dur > 0 ? dur - 500 : Number.MAX_SAFE_INTEGER);
    this.pendingSeek = target;
    this.progressOverride = { value: target, until: Date.now() + 2500 };
    if (this.state) {
      this.state.progressMs = target;
      this.state.sampledAt = Date.now();
    }
    this.emit("update");
    if (this.seekDebounce) clearTimeout(this.seekDebounce);
    this.seekDebounce = setTimeout(() => {
      const v = this.pendingSeek;
      this.pendingSeek = null;
      if (v === null) return;
      this.api.seek(v).catch((e) => this.emit("error", e));
    }, 250);
  }

  async setVolume(percent: number): Promise<void> {
    this.assertAvailable();
    const v = clamp(Math.round(percent), 0, 100);
    this.applyLocalVolume(v, 5000);
    await this.api.setVolume(v);
  }

  /** Relative volume, coalesced (dial twists). */
  volumeBy(delta: number): void {
    if (this.isLimited) return;
    const base = this.pendingVolume ?? this.volume;
    if (base === null) {
      // Unknown volume: fetch state, then the user can twist again.
      this.refreshSoon(0);
      return;
    }
    const v = clamp(base + delta, 0, 100);
    this.pendingVolume = v;
    this.applyLocalVolume(v, 5000);
    if (this.volumeDebounce) clearTimeout(this.volumeDebounce);
    this.volumeDebounce = setTimeout(() => {
      const value = this.pendingVolume;
      this.pendingVolume = null;
      if (value === null) return;
      this.api.setVolume(value).catch((e) => this.emit("error", e));
    }, 150);
  }

  async toggleMute(): Promise<void> {
    const cur = this.volume;
    if (cur === null) throw new SpotifyApiError(404, "NO_ACTIVE_DEVICE", "No active device");
    if (cur === 0) {
      await this.setVolume(this.mutedFrom ?? 50);
      this.mutedFrom = null;
    } else {
      this.mutedFrom = cur;
      await this.setVolume(0);
    }
  }

  private applyLocalVolume(v: number, holdMs = 1500): void {
    this.volumeOverride = { value: v, until: Date.now() + holdMs };
    if (this.state?.device) this.state.device.volume = v;
    this.emit("update");
  }

  async setShuffle(on: boolean): Promise<void> {
    this.assertAvailable();
    if (this.state) this.state.shuffle = on;
    this.emit("update");
    await this.api.setShuffle(on);
  }

  async setRepeat(mode: RepeatState): Promise<void> {
    this.assertAvailable();
    if (this.state) this.state.repeat = mode;
    this.emit("update");
    await this.api.setRepeat(mode);
  }

  async setLiked(liked: boolean): Promise<void> {
    this.assertAvailable();
    const t = this.state?.track;
    if (!isLikeable(t)) throw new Error("Nothing likeable is playing");
    const uri = t!.uri;
    const before = this.liked;
    this.liked = liked;
    this.likedFor = uri;
    this.emit("update");
    try {
      if (liked) await this.api.saveItem(uri);
      else await this.api.removeItem(uri);
    } catch (e) {
      this.liked = before;
      this.emit("update");
      throw e;
    }
  }

  async toggleLiked(): Promise<boolean> {
    this.assertAvailable();
    const t = this.state?.track;
    if (!isLikeable(t)) throw new Error("Nothing likeable is playing");
    let cur = this.likedFor === t!.uri ? this.liked : null;
    if (cur === null) cur = await this.api.isSaved(t!.uri);
    await this.setLiked(!cur);
    return !cur;
  }

  async playContext(uri: string, opts: { shuffle?: boolean; deviceId?: string } = {}): Promise<void> {
    this.assertAvailable();
    const deviceId = opts.deviceId ?? (await this.ensureDevice());
    const isTrackLike = /^spotify:(track|episode):/.test(uri);
    if (opts.shuffle !== undefined) {
      try {
        await this.api.setShuffle(opts.shuffle);
      } catch {
        /* shuffle may fail when nothing is active yet; harmless */
      }
    }
    await this.api.play(isTrackLike ? { uris: [uri], deviceId } : { contextUri: uri, deviceId });
    if (opts.shuffle !== undefined) {
      // Applying shuffle before play is unreliable on a cold device; re-apply after.
      setTimeout(() => this.api.setShuffle(opts.shuffle!).catch(() => {}), 500);
    }
    this.refreshSoon(900);
  }

  async transferTo(deviceId: string): Promise<void> {
    this.assertAvailable();
    await this.api.transfer(deviceId, this.state?.isPlaying ?? true);
    this.refreshSoon(1200);
  }

  getDevices(): Promise<Device[]> {
    this.assertAvailable();
    return this.api.getDevices();
  }
}

function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
