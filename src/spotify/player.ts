import streamDeck from "@elgato/streamdeck";
import { EventEmitter } from "node:events";
import { AuthError, type SpotifyAuth } from "./auth";
import { SpotifyApiError, type SpotifyClient, clamp } from "./client";
import type { Device, PlayerState, RepeatState } from "./types";

const logger = streamDeck.logger.createScope("player");

/** Tracks and podcast episodes can be saved to the library; ads and unknown items cannot. */
export function isLikeable(t: { uri: string; type: string } | null | undefined): boolean {
  return !!t && !!t.uri && (t.type === "track" || t.type === "episode");
}

const POLL_PLAYING_MS = 4000;
const POLL_IDLE_MS = 12000;
const POLL_ERROR_MAX_MS = 60000;
const TICK_MS = 1000;

/**
 * One shared poller for the whole plugin. Every action subscribes to it instead of hitting the API itself.
 *
 * - Polls /me/player at a sane cadence (4s while playing, 12s idle, back-off on errors) instead of every second.
 * - Interpolates progress locally once a second so progress bars move smoothly between polls.
 * - Coalesces volume / seek changes from dials so a fast twist becomes one request, with optimistic local state.
 * - Caches album art as data URIs and tracks the liked state of the current track.
 */
export class PlayerMonitor extends EventEmitter {
  state: PlayerState | null = null;
  /** Whether the current track is in Liked Songs; null when unknown. */
  liked: boolean | null = null;
  /** Album art of the current track as a data URI (null while loading / unavailable). */
  art: string | null = null;
  /** Last error message from polling, for display; null when healthy. */
  error: string | null = null;

  private pollTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  private polling: Promise<void> | null = null;
  private errorStreak = 0;
  private artCache = new Map<string, string>();
  private likedFor: string | null = null;

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
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.errorStreak = 0;
    logger.debug("Monitor started");
    void this.poll();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = this.tickTimer = null;
    logger.debug("Monitor stopped");
  }

  /** Ask for a fresh poll shortly (after a command), coalescing multiple requests. */
  refreshSoon(delayMs = 350): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delayMs);
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

  private schedule(): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    let delay: number;
    if (this.errorStreak > 0) delay = Math.min(POLL_IDLE_MS * 2 ** (this.errorStreak - 1), POLL_ERROR_MAX_MS);
    else delay = this.state?.isPlaying ? POLL_PLAYING_MS : POLL_IDLE_MS;
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
    try {
      const next = await this.api.getPlayerState();
      this.errorStreak = 0;
      this.error = null;
      const prev = this.state;
      this.state = next;

      const trackId = next?.track?.uri ?? null;
      const prevTrackId = prev?.track?.uri ?? null;
      if (trackId !== prevTrackId) {
        this.liked = null;
        this.likedFor = null;
        this.art = null;
        void this.loadArt(next?.track?.artUrl ?? null, trackId);
        void this.loadLiked(trackId);
        this.emit("track", next?.track ?? null);
      } else if (this.art === null && next?.track?.artUrl) {
        void this.loadArt(next.track.artUrl, trackId);
      }
      this.emit("update");
    } catch (e) {
      this.errorStreak++;
      if (e instanceof AuthError) {
        this.error = e.message;
      } else if (e instanceof SpotifyApiError) {
        this.error = e.message;
      } else {
        this.error = "Network error";
        logger.warn(`Poll failed: ${e}`);
      }
      this.emit("update");
    }
  }

  private tick(): void {
    if (this.state?.isPlaying) this.emit("tick");
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
    if (!uri || !isLikeable(this.state?.track)) return;
    try {
      const liked = await this.api.isSaved(uri);
      if ((this.state?.track?.uri ?? null) === uri) {
        this.liked = liked;
        this.likedFor = uri;
        this.emit("update");
      }
    } catch (e) {
      logger.warn(`Liked check failed: ${e}`);
    }
  }

  // ---- Commands (optimistic, coalesced where it matters) ------------------

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
    this.refreshSoon();
  }

  async next(): Promise<void> {
    await this.api.next();
    this.refreshSoon(500);
  }

  /** Spotify-app behaviour: restart the track when past the threshold, else go to the previous track. */
  async previous(restartThresholdMs = 3000): Promise<void> {
    if (restartThresholdMs > 0 && this.progressMs > restartThresholdMs) {
      await this.seekTo(0);
      return;
    }
    await this.api.previous();
    this.refreshSoon(500);
  }

  async seekTo(ms: number): Promise<void> {
    const dur = this.state?.track?.durationMs ?? 0;
    const target = clamp(ms, 0, dur > 0 ? dur - 500 : Number.MAX_SAFE_INTEGER);
    this.progressOverride = { value: target, until: Date.now() + 1500 };
    if (this.state) {
      this.state.progressMs = target;
      this.state.sampledAt = Date.now();
    }
    this.emit("update");
    await this.api.seek(target);
    this.refreshSoon(600);
  }

  /** Relative seek, coalesced (dial twists). */
  seekBy(deltaMs: number): void {
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
      this.api
        .seek(v)
        .then(() => this.refreshSoon(700))
        .catch((e) => this.emit("error", e));
    }, 250);
  }

  async setVolume(percent: number): Promise<void> {
    const v = clamp(Math.round(percent), 0, 100);
    this.applyLocalVolume(v);
    await this.api.setVolume(v);
    this.refreshSoon(800);
  }

  /** Relative volume, coalesced (dial twists). */
  volumeBy(delta: number): void {
    const base = this.pendingVolume ?? this.volume;
    if (base === null) {
      // Unknown volume: fetch state, then the user can twist again.
      this.refreshSoon(0);
      return;
    }
    const v = clamp(base + delta, 0, 100);
    this.pendingVolume = v;
    this.applyLocalVolume(v, 2500);
    if (this.volumeDebounce) clearTimeout(this.volumeDebounce);
    this.volumeDebounce = setTimeout(() => {
      const value = this.pendingVolume;
      this.pendingVolume = null;
      if (value === null) return;
      this.api
        .setVolume(value)
        .then(() => this.refreshSoon(900))
        .catch((e) => this.emit("error", e));
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
    if (this.state) this.state.shuffle = on;
    this.emit("update");
    await this.api.setShuffle(on);
    this.refreshSoon();
  }

  async setRepeat(mode: RepeatState): Promise<void> {
    if (this.state) this.state.repeat = mode;
    this.emit("update");
    await this.api.setRepeat(mode);
    this.refreshSoon();
  }

  async setLiked(liked: boolean): Promise<void> {
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
    const t = this.state?.track;
    if (!isLikeable(t)) throw new Error("Nothing likeable is playing");
    let cur = this.likedFor === t!.uri ? this.liked : null;
    if (cur === null) cur = await this.api.isSaved(t!.uri);
    await this.setLiked(!cur);
    return !cur;
  }

  async playContext(uri: string, opts: { shuffle?: boolean; deviceId?: string } = {}): Promise<void> {
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
    this.refreshSoon(700);
  }

  async transferTo(deviceId: string): Promise<void> {
    await this.api.transfer(deviceId, this.state?.isPlaying ?? true);
    this.refreshSoon(800);
  }

  getDevices(): Promise<Device[]> {
    return this.api.getDevices();
  }
}
