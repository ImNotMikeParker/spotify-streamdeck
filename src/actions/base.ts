import streamDeck, {
  SingletonAction,
  type DialAction,
  type DidReceiveSettingsEvent,
  type JsonObject,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { auth, describeError, player } from "../spotify";

const logger = streamDeck.logger.createScope("actions");
const HOLD_MS = 550;

export type AnyAction<T extends JsonObject> = KeyAction<T> | DialAction<T>;

/**
 * Shared plumbing for every action:
 * - keeps the latest settings per visible action instance,
 * - re-renders on every player update (and optionally every second while playing),
 * - starts/stops the shared poller based on whether anything is on screen,
 * - optional long-press detection for keys,
 * - uniform error handling (alert on the key + log).
 */
export abstract class SpotifyAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
  protected readonly settingsById = new Map<string, T>();
  /** Set to true to re-render once a second while playing (progress bars). */
  protected rendersProgress = false;
  /** Set to true to distinguish short and long presses (fires onPress on key up). */
  protected supportsLongPress = false;
  private holds = new Map<string, { timer: NodeJS.Timeout; long: boolean }>();

  constructor() {
    super();
    player.on("update", () => void this.renderAll());
    player.on("tick", () => {
      if (this.rendersProgress) void this.renderAll();
    });
    auth.on("status", () => void this.renderAll());
  }

  /** Draw the action for the current player state. */
  protected abstract render(action: AnyAction<T>, settings: T): Promise<void>;

  /** Short press (key up before the hold threshold, or key down when long press is unsupported). */
  protected onPress?(action: AnyAction<T>, settings: T, ev: KeyDownEvent<T> | KeyUpEvent<T>): Promise<void>;
  /** Long press, only when supportsLongPress is true. */
  protected onLongPress?(action: AnyAction<T>, settings: T): Promise<void>;

  override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
    this.settingsById.set(ev.action.id, ev.payload.settings ?? ({} as T));
    player.start();
    await this.safeRender(ev.action, ev.payload.settings ?? ({} as T));
  }

  override onWillDisappear(ev: WillDisappearEvent<T>): void {
    this.settingsById.delete(ev.action.id);
    this.holds.delete(ev.action.id);
    // Let the store settle, then stop polling if nothing from this plugin is visible any more.
    setTimeout(() => {
      if (streamDeck.actions.length === 0) player.stop();
    }, 50);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
    this.settingsById.set(ev.action.id, ev.payload.settings ?? ({} as T));
    await this.safeRender(ev.action, ev.payload.settings ?? ({} as T));
  }

  override async onKeyDown(ev: KeyDownEvent<T>): Promise<void> {
    const settings = ev.payload.settings ?? this.settingsById.get(ev.action.id) ?? ({} as T);
    this.settingsById.set(ev.action.id, settings);
    if (!this.supportsLongPress || !this.onLongPress) {
      await this.press(ev.action, settings, ev);
      return;
    }
    const existing = this.holds.get(ev.action.id);
    if (existing) clearTimeout(existing.timer);
    const entry = {
      long: false,
      timer: setTimeout(() => {
        entry.long = true;
        void this.guard(ev.action, () => this.onLongPress!(ev.action, settings));
      }, HOLD_MS),
    };
    this.holds.set(ev.action.id, entry);
  }

  override async onKeyUp(ev: KeyUpEvent<T>): Promise<void> {
    const entry = this.holds.get(ev.action.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.holds.delete(ev.action.id);
    if (entry.long) return;
    const settings = ev.payload.settings ?? this.settingsById.get(ev.action.id) ?? ({} as T);
    await this.press(ev.action, settings, ev);
  }

  private async press(action: AnyAction<T>, settings: T, ev: KeyDownEvent<T> | KeyUpEvent<T>): Promise<void> {
    if (!this.onPress) return;
    await this.guard(action, () => this.onPress!(action, settings, ev));
  }

  /** Runs a command; on failure shows the alert triangle on the key and logs why. */
  protected async guard(action: AnyAction<T>, fn: () => Promise<void>): Promise<boolean> {
    if (!auth.isConnected) {
      await action.showAlert();
      return false;
    }
    try {
      await fn();
      return true;
    } catch (e) {
      logger.warn(`${this.manifestId}: ${describeError(e)}`);
      await action.showAlert();
      player.refreshSoon(300);
      return false;
    }
  }

  protected async renderAll(): Promise<void> {
    for (const action of this.actions) {
      await this.safeRender(action, this.settingsById.get(action.id) ?? ({} as T));
    }
  }

  private async safeRender(action: AnyAction<T>, settings: T): Promise<void> {
    try {
      await this.render(action, settings);
    } catch (e) {
      logger.error(`Render failed for ${this.manifestId}: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }
}

/** Reads the state a multi-action asked for (undefined when the key was pressed directly). */
export function desiredState(ev: KeyDownEvent<JsonObject> | KeyUpEvent<JsonObject>): number | undefined {
  const p = ev.payload as { userDesiredState?: number; isInMultiAction?: boolean; state?: number };
  return p.isInMultiAction ? (p.userDesiredState ?? p.state) : undefined;
}
