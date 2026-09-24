import streamDeck from "@elgato/streamdeck";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const logger = streamDeck.logger.createScope("local");

/**
 * Zero-cost change detection for the Spotify desktop app on Windows.
 *
 * The Spotify window title is "Artist - Track" while playing and "Spotify" / "Spotify Premium" / "Spotify Free"
 * while paused, so a long-lived PowerShell child that prints the title whenever it changes lets us know the
 * instant a track starts or playback pauses without spending a single Web API call. On other platforms, or if
 * the child cannot start, `available` stays false and the player falls back to (slower) API polling.
 *
 * Events: "change" (title: string | null)  -  null means no Spotify window was found.
 */
export class LocalSpotifyWatcher extends EventEmitter {
  /** True while the watcher child is running and reporting. */
  available = false;
  /** Last title seen; null when Spotify is not running. */
  title: string | null = null;
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;

  start(): void {
    if (process.platform !== "win32" || this.child) return;
    this.stopped = false;
    const script =
      "$last = $null; " +
      "while ($true) { " +
      "$p = [System.Diagnostics.Process]::GetProcessesByName('Spotify') | Where-Object { $_.MainWindowTitle } | Select-Object -First 1; " +
      "$t = if ($p) { $p.MainWindowTitle } else { '<none>' }; " +
      "if ($t -ne $last) { $last = $t; [Console]::Out.WriteLine($t); [Console]::Out.Flush() }; " +
      "Start-Sleep -Milliseconds 1000 }";
    try {
      this.child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (e) {
      logger.warn(`Could not start window watcher: ${e}`);
      return;
    }
    let buffer = "";
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "").trim();
        buffer = buffer.slice(i + 1);
        this.available = true;
        this.restarts = 0;
        const title = line === "<none>" || line === "" ? null : line;
        this.title = title;
        this.emit("change", title);
      }
    });
    this.child.on("exit", (code) => {
      this.child = null;
      this.available = false;
      if (this.stopped) return;
      if (this.restarts++ < 5) {
        logger.warn(`Window watcher exited (${code}); restarting`);
        setTimeout(() => this.start(), 2000 * this.restarts);
      } else {
        logger.warn("Window watcher keeps exiting; falling back to API polling");
      }
    });
    logger.info("Window watcher started");
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.available = false;
  }

  /** Splits "Artist - Track" into parts; null for the idle titles. */
  static parse(title: string | null): { artist: string; track: string } | null {
    if (!title) return null;
    if (/^(Spotify( Premium| Free)?|Advertisement)$/i.test(title)) return null;
    const i = title.indexOf(" - ");
    if (i < 0) return null;
    return { artist: title.slice(0, i).trim(), track: title.slice(i + 3).trim() };
  }

  /** True for the titles Spotify shows while paused or idle. */
  static isIdleTitle(title: string | null): boolean {
    return !!title && /^Spotify( Premium| Free)?$/i.test(title);
  }
}

process.on("exit", () => {
  /* children are killed by the watcher's stop(); nothing else to do */
});
