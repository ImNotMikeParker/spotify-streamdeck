import streamDeck from "@elgato/streamdeck";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AuthStatus, GlobalSettings } from "./types";

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const DEFAULT_PORT = 8888;

export const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-private",
].join(" ");

const logger = streamDeck.logger.createScope("auth");

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class AuthError extends Error {}

/**
 * Handles Spotify Authorization Code + PKCE, token persistence (in Stream Deck global settings) and refresh.
 * No client secret is needed, so nothing beyond the user's own tokens is ever stored.
 */
export class SpotifyAuth extends EventEmitter {
  private settings: GlobalSettings = {};
  private refreshing: Promise<string> | null = null;
  private pending: { server: http.Server; timer: NodeJS.Timeout } | null = null;
  private lastMessage: string | undefined;
  private busy = false;

  async init(): Promise<void> {
    this.settings = (await streamDeck.settings.getGlobalSettings<GlobalSettings>()) ?? {};
    streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
      // Keep our copy in sync when the property inspector (or we) write settings.
      this.settings = ev.settings ?? {};
    });
    logger.info(`Loaded settings: clientId=${this.settings.clientId ? "set" : "missing"}, refreshToken=${this.settings.refreshToken ? "set" : "missing"}`);
    this.emit("status", this.status());
  }

  get port(): number {
    return this.settings.port || DEFAULT_PORT;
  }

  get redirectUri(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get isConnected(): boolean {
    return !!(this.settings.clientId && this.settings.refreshToken);
  }

  status(): AuthStatus {
    return {
      connected: this.isConnected,
      userName: this.settings.userName,
      clientId: this.settings.clientId,
      port: this.port,
      redirectUri: this.redirectUri,
      message: this.lastMessage,
      busy: this.busy,
    };
  }

  private async save(patch: Partial<GlobalSettings>): Promise<void> {
    // Always merge on top of the freshest copy so we never clobber values written elsewhere.
    const current = (await streamDeck.settings.getGlobalSettings<GlobalSettings>()) ?? {};
    const next: GlobalSettings = { ...current, ...patch };
    for (const k of Object.keys(next) as (keyof GlobalSettings)[]) if (next[k] === undefined) delete next[k];
    this.settings = next;
    await streamDeck.settings.setGlobalSettings(next);
  }

  private setMessage(message: string | undefined): void {
    this.lastMessage = message;
    this.emit("status", this.status());
  }

  /** Returns a valid access token, refreshing if needed. Throws AuthError when not connected. */
  async getAccessToken(): Promise<string> {
    if (!this.isConnected) throw new AuthError("Not connected to Spotify. Open an action's settings and click Connect.");
    const { accessToken, expiresAt } = this.settings;
    if (accessToken && expiresAt && Date.now() < expiresAt - 30_000) return accessToken;
    return this.refresh();
  }

  /** Force a refresh (e.g. after a 401). De-duplicated so parallel callers share one request. */
  refresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const { clientId, refreshToken } = this.settings;
    if (!clientId || !refreshToken) throw new AuthError("Not connected to Spotify.");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) {
      const text = await res.text();
      logger.error(`Token refresh failed (${res.status}): ${text}`);
      if (res.status === 400 || res.status === 401) {
        // Refresh token revoked/expired: force a re-connect.
        await this.save({ refreshToken: undefined, accessToken: undefined, expiresAt: undefined });
        this.setMessage("Spotify session expired. Please connect again.");
        throw new AuthError("Spotify session expired. Please connect again.");
      }
      throw new Error(`Token refresh failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    await this.save({
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    });
    return json.access_token;
  }

  async disconnect(): Promise<void> {
    this.cancelPending();
    await this.save({ refreshToken: undefined, accessToken: undefined, expiresAt: undefined, userName: undefined });
    this.setMessage("Disconnected.");
  }

  /**
   * Starts the PKCE flow: spins up a loopback HTTP server, opens the browser, waits for the callback, exchanges the code.
   * Resolves once tokens are stored.
   */
  async connect(clientId: string, port?: number): Promise<void> {
    clientId = clientId.trim();
    if (!/^[a-f0-9]{32}$/i.test(clientId)) {
      this.setMessage("That does not look like a Spotify Client ID (32 hex characters).");
      throw new AuthError("Invalid client id");
    }
    this.cancelPending();
    await this.save({ clientId, port: port && port > 0 && port < 65536 ? port : undefined });
    this.busy = true;
    this.setMessage("Waiting for you to approve access in the browser...");

    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    const authorizeUrl =
      `${AUTHORIZE_URL}?` +
      new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: this.redirectUri,
        scope: SCOPES,
        state,
        code_challenge_method: "S256",
        code_challenge: challenge,
      }).toString();

    try {
      const code = await this.waitForCallback(state, authorizeUrl);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      });
      const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
      const json = (await res.json()) as { access_token: string; expires_in: number; refresh_token: string };
      await this.save({ accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000, refreshToken: json.refresh_token });

      // Fetch the display name so the UI can show who is connected.
      let premiumNote = "";
      try {
        const me = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${json.access_token}` } });
        if (me.ok) {
          const info = (await me.json()) as { display_name?: string; id: string; product?: string };
          await this.save({ userName: info.display_name || info.id });
          if (info.product && info.product !== "premium") premiumNote = " Note: Spotify Premium is required for playback control.";
        }
      } catch (e) {
        logger.warn(`Could not fetch profile: ${e}`);
      }
      this.setMessage(`Connected as ${this.settings.userName ?? "Spotify user"}.${premiumNote}`);
      this.emit("connected");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Connect failed: ${msg}`);
      this.setMessage(`Connect failed: ${msg}`);
      throw e;
    } finally {
      this.busy = false;
      this.emit("status", this.status());
    }
  }

  private cancelPending(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.server.close();
      this.pending = null;
    }
  }

  private waitForCallback(expectedState: string, authorizeUrl: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const finish = (ok: boolean, title: string, detail: string) => {
          res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(resultPage(ok, title, detail));
          setTimeout(() => this.cancelPending(), 500);
        };
        if (error) {
          finish(false, "Spotify said no", `Authorization was declined (${error}). You can close this tab.`);
          reject(new AuthError(`Authorization declined: ${error}`));
          return;
        }
        if (!code || state !== expectedState) {
          finish(false, "Something went wrong", "The callback was missing a code or had a bad state value. Try connecting again.");
          reject(new AuthError("Invalid callback"));
          return;
        }
        finish(true, "Stream Deck is connected to Spotify", "You can close this tab and go back to Stream Deck.");
        resolve(code);
      });

      server.once("error", (err: NodeJS.ErrnoException) => {
        this.pending = null;
        reject(
          new AuthError(
            err.code === "EADDRINUSE"
              ? `Port ${this.port} is already in use. Pick another port in the settings and add the matching redirect URI to your Spotify app.`
              : err.message,
          ),
        );
      });

      server.listen(this.port, "127.0.0.1", () => {
        const timer = setTimeout(() => {
          this.cancelPending();
          reject(new AuthError("Timed out waiting for the browser. Try again."));
        }, 5 * 60_000);
        this.pending = { server, timer };
        logger.info(`Listening for OAuth callback on ${this.redirectUri}`);
        streamDeck.system.openUrl(authorizeUrl).catch((e) => logger.error(`openUrl failed: ${e}`));
      });
    });
  }
}

function resultPage(ok: boolean, title: string, detail: string): string {
  const color = ok ? "#1DB954" : "#e5484d";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#121212;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh}
.card{max-width:420px;padding:40px;border-radius:16px;background:#181818;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.dot{width:64px;height:64px;border-radius:50%;background:${color};margin:0 auto 24px;display:flex;align-items:center;justify-content:center;font-size:32px}
h1{font-size:22px;margin:0 0 12px}p{color:#b3b3b3;line-height:1.5;margin:0}</style></head>
<body><div class="card"><div class="dot">${ok ? "&#10003;" : "&#10007;"}</div><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}
