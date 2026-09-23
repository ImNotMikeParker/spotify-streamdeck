import streamDeck from "@elgato/streamdeck";
import { AuthError, type SpotifyAuth } from "./auth";
import type { Device, Playlist, PlayerState, RepeatState, Track } from "./types";

const API = "https://api.spotify.com/v1";
const logger = streamDeck.logger.createScope("api");

export class SpotifyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
  }
  get noActiveDevice(): boolean {
    return this.status === 404 && (this.reason === "NO_ACTIVE_DEVICE" || /no active device/i.test(this.message));
  }
  get premiumRequired(): boolean {
    return this.status === 403 && (this.reason === "PREMIUM_REQUIRED" || /premium/i.test(this.message));
  }
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Internal: whether this is the retry after a 401. */
  retried?: boolean;
};

/** Thin, well-behaved wrapper over the Spotify Web API: auth headers, one automatic token refresh, 429 back-off, 204 handling. */
export class SpotifyClient {
  constructor(private readonly auth: SpotifyAuth) {}

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T | null> {
    const token = await this.auth.getAccessToken();
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 204 || res.status === 202) return null;
    if (res.ok) {
      // Player commands sometimes answer 200 with a plain-text request id instead of JSON; treat that as success.
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        logger.debug(`${method} ${path} -> ${res.status} non-JSON body: ${text.slice(0, 40)}`);
        return null;
      }
    }

    if (res.status === 401 && !opts.retried) {
      await this.auth.refresh();
      return this.request<T>(method, path, { ...opts, retried: true });
    }
    if (res.status === 429 && !opts.retried) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? "1") * 1000, 5000);
      logger.warn(`Rate limited on ${method} ${path}; waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return this.request<T>(method, path, { ...opts, retried: true });
    }

    let message = `${res.status} ${res.statusText}`;
    let reason: string | undefined;
    try {
      const err = (await res.json()) as { error?: { message?: string; reason?: string } };
      if (err.error?.message) message = err.error.message;
      reason = err.error?.reason;
    } catch {
      /* not json */
    }
    logger.warn(`${method} ${path} -> ${res.status} ${reason ?? ""} ${message}`);
    throw new SpotifyApiError(res.status, reason, message);
  }

  // ---- Player -------------------------------------------------------------

  async getPlayerState(): Promise<PlayerState | null> {
    const raw = await this.request<RawPlayer>("GET", "/me/player", { query: { additional_types: "track,episode" } });
    if (!raw) return null;
    return normalizePlayer(raw);
  }

  play(opts: { contextUri?: string; uris?: string[]; deviceId?: string; positionMs?: number } = {}): Promise<null> {
    const body: Record<string, unknown> = {};
    if (opts.contextUri) body.context_uri = opts.contextUri;
    if (opts.uris) body.uris = opts.uris;
    if (opts.positionMs !== undefined) body.position_ms = opts.positionMs;
    return this.request("PUT", "/me/player/play", { query: { device_id: opts.deviceId }, body: Object.keys(body).length ? body : undefined }) as Promise<null>;
  }
  pause(): Promise<null> {
    return this.request("PUT", "/me/player/pause") as Promise<null>;
  }
  next(): Promise<null> {
    return this.request("POST", "/me/player/next") as Promise<null>;
  }
  previous(): Promise<null> {
    return this.request("POST", "/me/player/previous") as Promise<null>;
  }
  seek(positionMs: number): Promise<null> {
    return this.request("PUT", "/me/player/seek", { query: { position_ms: Math.max(0, Math.round(positionMs)) } }) as Promise<null>;
  }
  setVolume(percent: number): Promise<null> {
    return this.request("PUT", "/me/player/volume", { query: { volume_percent: clamp(Math.round(percent), 0, 100) } }) as Promise<null>;
  }
  setShuffle(state: boolean): Promise<null> {
    return this.request("PUT", "/me/player/shuffle", { query: { state } }) as Promise<null>;
  }
  setRepeat(state: RepeatState): Promise<null> {
    return this.request("PUT", "/me/player/repeat", { query: { state } }) as Promise<null>;
  }
  addToQueue(uri: string): Promise<null> {
    return this.request("POST", "/me/player/queue", { query: { uri } }) as Promise<null>;
  }
  async getDevices(): Promise<Device[]> {
    const raw = await this.request<{ devices: RawDevice[] }>("GET", "/me/player/devices");
    return (raw?.devices ?? []).map(normalizeDevice);
  }
  transfer(deviceId: string, play = true): Promise<null> {
    return this.request("PUT", "/me/player", { body: { device_ids: [deviceId], play } }) as Promise<null>;
  }

  // ---- Library ------------------------------------------------------------

  // Spotify replaced /me/tracks(+/contains) with the URI-based /me/library endpoints; the old ones 403 for newer apps.
  async isSaved(uri: string): Promise<boolean> {
    const r = await this.request<boolean[]>("GET", "/me/library/contains", { query: { uris: uri } });
    return !!r?.[0];
  }
  saveItem(uri: string): Promise<null> {
    return this.request("PUT", "/me/library", { query: { uris: uri } }) as Promise<null>;
  }
  removeItem(uri: string): Promise<null> {
    return this.request("DELETE", "/me/library", { query: { uris: uri } }) as Promise<null>;
  }

  // ---- Playlists ----------------------------------------------------------

  async getMyPlaylists(): Promise<Playlist[]> {
    const out: Playlist[] = [];
    let url: string | null = "/me/playlists?limit=50";
    let guard = 0;
    while (url && guard++ < 20) {
      const page: RawPage<RawPlaylist> | null = await this.request<RawPage<RawPlaylist>>("GET", url);
      if (!page) break;
      for (const p of page.items) {
        if (!p) continue;
        out.push({ id: p.id, uri: p.uri, name: p.name, owner: p.owner?.display_name ?? p.owner?.id ?? "", trackCount: p.tracks?.total ?? 0 });
      }
      url = page.next ? page.next.replace(API, "") : null;
    }
    return out;
  }

  /** Returns true if the playlist already contains the track (scans up to 2000 items). */
  async playlistContains(playlistId: string, trackUri: string): Promise<boolean> {
    let url: string | null = `/playlists/${playlistId}/items?limit=100&fields=next,items(item(uri))`;
    let guard = 0;
    while (url && guard++ < 20) {
      const page: RawPage<{ item?: { uri?: string }; track?: { uri?: string } }> | null = await this.request("GET", url);
      if (!page) break;
      if (page.items.some((i) => (i.item?.uri ?? i.track?.uri) === trackUri)) return true;
      url = page.next ? page.next.replace(API, "") : null;
    }
    return false;
  }
  addToPlaylist(playlistId: string, uri: string): Promise<null> {
    return this.request("POST", `/playlists/${playlistId}/items`, { body: { uris: [uri] } }) as Promise<null>;
  }
  removeFromPlaylist(playlistId: string, uri: string): Promise<null> {
    return this.request("DELETE", `/playlists/${playlistId}/items`, { body: { items: [{ uri }] } }) as Promise<null>;
  }

  /** Small helper for album art: download and return a data URI (JPEG) so keys/layouts can embed it. */
  async fetchImageDataUri(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
    const type = res.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  }
}

export { AuthError };

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ---- Raw API shapes (only what we use) -----------------------------------

type RawImage = { url: string; width: number | null; height: number | null };
type RawDevice = { id: string | null; name: string; type: string; is_active: boolean; volume_percent: number | null; supports_volume: boolean };
type RawItem = {
  id: string | null;
  uri: string;
  name: string;
  type: "track" | "episode";
  duration_ms: number;
  artists?: { name: string }[];
  album?: { name: string; images: RawImage[] };
  show?: { name: string; publisher?: string; images: RawImage[] };
  images?: RawImage[];
};
type RawPlayer = {
  device: RawDevice | null;
  shuffle_state: boolean;
  repeat_state: RepeatState;
  progress_ms: number | null;
  is_playing: boolean;
  context: { uri: string } | null;
  item: RawItem | null;
  currently_playing_type: "track" | "episode" | "ad" | "unknown";
};
type RawPage<T> = { items: T[]; next: string | null };
type RawPlaylist = { id: string; uri: string; name: string; owner?: { display_name?: string; id?: string }; tracks?: { total: number } };

function normalizeDevice(d: RawDevice): Device {
  return { id: d.id, name: d.name, type: d.type, isActive: d.is_active, volume: d.volume_percent, supportsVolume: d.supports_volume };
}

function pickArt(images: RawImage[] | undefined, target = 300): string | null {
  if (!images?.length) return null;
  // Prefer the smallest image that is still >= target, else the largest available.
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= target) ?? sorted[sorted.length - 1]).url;
}

function normalizePlayer(raw: RawPlayer): PlayerState {
  let track: Track | null = null;
  const item = raw.item;
  if (item) {
    const isEpisode = item.type === "episode";
    track = {
      id: item.id,
      uri: item.uri,
      name: item.name,
      artists: isEpisode ? (item.show?.name ?? "") : (item.artists ?? []).map((a) => a.name).join(", "),
      album: isEpisode ? (item.show?.publisher ?? "") : (item.album?.name ?? ""),
      artUrl: pickArt(isEpisode ? (item.images ?? item.show?.images) : item.album?.images),
      durationMs: item.duration_ms,
      type: item.type,
    };
  } else if (raw.currently_playing_type === "ad") {
    track = { id: null, uri: "", name: "Advertisement", artists: "", album: "", artUrl: null, durationMs: 0, type: "ad" };
  }
  return {
    isPlaying: raw.is_playing,
    progressMs: raw.progress_ms ?? 0,
    sampledAt: Date.now(),
    shuffle: raw.shuffle_state,
    repeat: raw.repeat_state,
    contextUri: raw.context?.uri ?? null,
    device: raw.device ? normalizeDevice(raw.device) : null,
    track,
  };
}
