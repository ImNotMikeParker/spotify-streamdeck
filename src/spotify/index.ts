import streamDeck from "@elgato/streamdeck";
import { SpotifyAuth } from "./auth";
import { SpotifyClient, SpotifyApiError, AuthError, RateLimitError } from "./client";
import { PlayerMonitor } from "./player";

export const auth = new SpotifyAuth();
export const api = new SpotifyClient(auth);
export const player = new PlayerMonitor(api, auth);

const logger = streamDeck.logger.createScope("spotify");

player.on("error", (e) => logger.warn(`Background command failed: ${e instanceof Error ? e.message : e}`));

/** Turns an error into a short message suitable for logs and the property inspector. */
export function describeError(e: unknown): string {
  if (e instanceof AuthError) return e.message;
  if (e instanceof RateLimitError) return player.error ?? e.message;
  if (e instanceof SpotifyApiError) {
    if (e.premiumRequired) return "Spotify Premium is required for playback control.";
    if (e.noActiveDevice) return "No active Spotify device. Open Spotify somewhere and press play once.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export { SpotifyApiError, AuthError };
