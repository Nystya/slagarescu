# Hitster Night

A multiplayer web version of the Hitster music card game. A laptop runs the
game and plays the music; everyone plays from their own phone on the same Wi-Fi.

No dependencies (just Node 18+), no Spotify login — songs play as 30-second
Spotify previews.

## Play

```sh
npm start        # or: node server.js
```

1. Open **http://localhost:3000/host** on the laptop (hook it up to a speaker or TV).
2. Friends scan the QR code or open the printed `http://<lan-ip>:3000` on their phones
   and type their name.
3. Pick the number of cards to win and hit **Start game**.

The host screen plays the song and shows the active player's timeline live.
Phones show your own timeline; on your turn you tap a spot and lock it in, on
others' turns you can steal. The host runs the reveal and the next song. If a phone reloads or locks, it rejoins as the same
player. The game is saved to `data/game-state.json`, so restarting the server
picks up where you left off.

If phones can't connect, check they're on the same Wi-Fi (not a guest network)
and allow incoming connections for Node if macOS asks. Use `PORT=8080 npm start`
to change the port.

## Rules (as implemented)

- Everyone starts with one face-up card and 2 tokens (max 5).
- On your turn, listen and tap the spot in your timeline where the song belongs.
- Other players may **steal** (1 token): they pick a different spot. If you're
  wrong and they're right, they get the card.
- Only the host can **reveal** the card, move on to the **next song**, and award
  **+1 token** when the player guessed the title and artist.
- Spend 1 token to **skip** a song, or 3 tokens to **buy** a card placed for free.
- First to the target number of cards (default 10) wins.
- The host can pass a stuck player's turn or remove a player from the menu.
  Late arrivals can join mid-game with a starting card.

## Code

- `server.js` — static files, Server-Sent Events (`/events`), moves (`POST /api/action`).
- `game.js` — all game rules and state; clients never see the current song before the reveal.
- `public/` — one page that renders the host screen (`/host`) or the player view (`/`).

## Songs

`data/songs.json` is generated from a Spotify playlist (currently 398 songs):

```sh
node tools/fetch-playlist.mjs --tracks data/tracks.txt  # every song in the playlist
node tools/fetch-playlist.mjs <playlist-url-or-id>      # first 100 songs only
```

`data/tracks.txt` holds the playlist's track links: in the Spotify desktop app,
open the playlist, click a song, press Cmd/Ctrl+A then Cmd/Ctrl+C, and paste.
(Spotify's public embed only lists 100 songs, and its Web API now needs a
Premium developer account.) Each song's year and 30-second preview come from
its public embed page — no API key needed.

Duplicates (same title and artists) are dropped. Spotify often reports
remaster/compilation dates, so `data/year-overrides.json` maps song titles to
their original release year, and its `_exclude` list drops specific track ids —
edit it when something looks wrong, then re-run the script and restart the server.
