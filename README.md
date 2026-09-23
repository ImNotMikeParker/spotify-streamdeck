# Simply Spotify

Spotify, simplified. Fast, live Spotify control for Stream Deck and Stream Deck +, built on Elgato's official Node.js SDK.

**Why another one?**

- **One shared, polite poller.** Every key reads from a single player monitor that polls Spotify every 4 s while playing and 12 s when idle, backs off on errors, refreshes tokens automatically and coalesces dial twists into single requests. No more once-a-second hammering, no more random "broken" state.
- **A Like button that actually knows.** The heart is checked against your library the moment the track changes, updates optimistically on press, and reverts if Spotify says no. Works for podcast episodes too.
- **Stream Deck + support.** Album art, track, artist, elapsed time and a progress bar on the touch strip. Dials for volume and scrubbing. Tap for next, long-tap for like.
- **Album art everywhere.** Play/Pause and Now Playing keys show the cover with a live progress bar.
- **Sane setup.** PKCE sign-in: paste your Client ID, click Connect, approve in the browser. No client secret, nothing stored but your own tokens.

## Actions

| Key | What it does |
| --- | --- |
| Play / Pause | Toggles playback. Album art + progress. Long-press for next / previous / like. |
| Now Playing | Art, track and artist, always live. Press and long-press are configurable. |
| Next / Previous | Previous restarts the track when more than 3 s in, like the Spotify app. |
| Like | Heart fills green when the current track is saved. Press to toggle. Multi Action can force Like / Unlike. |
| Shuffle / Repeat | Toggle / cycle, with live state shown on the key. |
| Volume | Up, down, mute or set to a level. Shows current volume. |
| Seek | Jump ±N seconds. |
| Play Playlist / URI | Pick one of your playlists from a list, or paste any Spotify link. Turns green while it is playing. |
| Add to Playlist | Adds the current track to a chosen playlist, skipping duplicates. |
| Playback Device | Moves playback to a specific device. Highlights when active. |

| Dial (Stream Deck +) | Rotate | Press | Tap | Long tap |
| --- | --- | --- | --- | --- |
| Now Playing | Volume (or scrub) | Play / pause | Next | Like |
| Scrub | Scrub through track | Play / pause | Next | Previous |
| Volume | Volume | Mute | Play / pause | Next |

All of those are configurable per action.

## Setup (once, about two minutes)

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
2. Any name and description. Under **Redirect URIs** add exactly `http://127.0.0.1:8888/callback`. Tick **Web API**. Save.
3. Copy the app's **Client ID**.
4. In Stream Deck, drop any Simply Spotify action on a key, paste the Client ID in its settings and click **Connect to Spotify**. Approve in the browser.

Spotify Premium is required for playback control (Spotify's rule, not ours). Free accounts can still see Now Playing and use Like.

Why your own developer app? Spotify caps each app in development mode at 5 users and only grants larger quotas to registered businesses, so a shared Client ID is not possible for an independent plugin. Your app is yours alone and nothing leaves your machine except calls to Spotify.

If port 8888 is taken on your machine, change the port in the settings and use the matching redirect URI in the dashboard.

## Development

```bash
npm install
npm run icons      # regenerate imgs/ from src/render/svg.ts
npm run ui         # regenerate property inspector pages
npm run build      # bundle to com.mjp.spotifydeck.sdPlugin/bin/plugin.js
npm run link       # symlink the plugin into Stream Deck's plugins folder
npm run restart    # restart the running plugin (see note)
npm run validate   # Elgato manifest/layout validation
npm run pack       # build a distributable .streamDeckPlugin
```

Note on `restart`: Stream Deck 7.0.x ignores the CLI restart for side-loaded plugins. `npm run restart:force` ends the plugin's Node process so Stream Deck relaunches it.

Targets Stream Deck 6.5+ and the bundled Node 20 runtime (`@elgato/streamdeck` 1.x), so it runs on current and older Stream Deck installs. Logs live in `com.mjp.spotifydeck.sdPlugin/logs/`.

### Layout

- `src/spotify/auth.ts` – PKCE flow, loopback callback server, token refresh, global settings persistence.
- `src/spotify/client.ts` – thin Web API wrapper (auth header, one automatic refresh on 401, 429 back-off, 204 handling).
- `src/spotify/player.ts` – the shared monitor: polling cadence, interpolated progress, optimistic and coalesced volume/seek, liked state, album art cache.
- `src/actions/*` – one class per action; `base.ts` handles settings tracking, re-rendering, long-press and error alerts.
- `src/render/svg.ts` – key images are composed as SVG (album art, glyphs, text, progress) and sent as data URIs.
- `com.mjp.spotifydeck.sdPlugin/ui/` – property inspectors; `common.js` renders the shared account section.
- `com.mjp.spotifydeck.sdPlugin/layouts/now-playing.json` – touch-strip layout for the dials.

## Notes

- Uses Spotify's current `/me/library` endpoints for Like (the older `/me/tracks` ones return 403 for newly created apps) and `/playlists/{id}/items` for playlists.
- Global settings (Client ID, tokens) are stored by Stream Deck like any other plugin's settings.
