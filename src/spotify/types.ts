export type RepeatState = "off" | "context" | "track";

/**
 * What the plugin persists in Stream Deck's global settings. Only durable values: the short-lived access token
 * lives in memory, so settings are written only when one of these actually changes (see SpotifyAuth.persist).
 */
export type GlobalSettings = {
  clientId?: string;
  port?: number;
  refreshToken?: string;
  userName?: string;
  /** Epoch ms of the last write; used to pick the newer of Stream Deck's copy and the encrypted backup. */
  savedAt?: number;
  /** Legacy (<= 1.0.1) fields, stripped on the next write. */
  accessToken?: string;
  expiresAt?: number;
};

export type Track = {
  id: string | null;
  uri: string;
  name: string;
  artists: string;
  album: string;
  artUrl: string | null;
  durationMs: number;
  type: "track" | "episode" | "ad" | "unknown";
};

export type Device = {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  volume: number | null;
  supportsVolume: boolean;
};

export type PlayerState = {
  isPlaying: boolean;
  progressMs: number;
  /** Epoch ms when progressMs was sampled. */
  sampledAt: number;
  shuffle: boolean;
  repeat: RepeatState;
  contextUri: string | null;
  device: Device | null;
  track: Track | null;
};

export type Playlist = {
  id: string;
  uri: string;
  name: string;
  owner: string;
  trackCount: number;
};

export type AuthStatus = {
  connected: boolean;
  userName?: string;
  clientId?: string;
  port: number;
  redirectUri: string;
  /** Human-readable status or last error. */
  message?: string;
  busy?: boolean;
};
