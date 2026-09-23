import { api } from "./index";
import type { Device, Playlist } from "./types";

/**
 * Small cache of the user's playlists and devices, used by property inspectors (dropdowns) and key labels.
 */
class Catalog {
  private playlists: Playlist[] = [];
  private playlistsAt = 0;
  private devices: Device[] = [];

  async getPlaylists(force = false): Promise<Playlist[]> {
    if (force || !this.playlists.length || Date.now() - this.playlistsAt > 10 * 60_000) {
      this.playlists = await api.getMyPlaylists();
      this.playlistsAt = Date.now();
    }
    return this.playlists;
  }

  playlistName(uri: string): string | undefined {
    const hit = this.playlists.find((p) => p.uri === uri);
    if (!hit && !this.playlists.length && this.playlistsAt === 0) {
      // Lazily warm the cache so labels appear on next render.
      this.playlistsAt = -1;
      this.getPlaylists().catch(() => (this.playlistsAt = 0));
    }
    return hit?.name;
  }

  playlistContains(playlistId: string, trackUri: string): Promise<boolean> {
    return api.playlistContains(playlistId, trackUri);
  }

  addToPlaylist(playlistId: string, trackUri: string): Promise<null> {
    return api.addToPlaylist(playlistId, trackUri);
  }

  async getDevices(): Promise<Device[]> {
    this.devices = await api.getDevices();
    return this.devices;
  }

  /** Device dropdown values are "id::name" so the key can show a name and survive id changes. */
  deviceValue(d: Device): string {
    return `${d.id ?? ""}::${d.name}`;
  }

  parseDeviceValue(v: string | undefined): { id: string; name: string } {
    if (!v) return { id: "", name: "" };
    const i = v.indexOf("::");
    return i < 0 ? { id: v, name: "" } : { id: v.slice(0, i), name: v.slice(i + 2) };
  }
}

export const catalog = new Catalog();
