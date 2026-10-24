#!/usr/bin/env node
// Builds data/songs.json from a public Spotify playlist.
//
//   node tools/fetch-playlist.mjs [playlist-url-or-id]
//   node tools/fetch-playlist.mjs --tracks data/tracks.txt
//
// --tracks reads a file of track links, e.g. pasted after selecting every song
// in a playlist in the Spotify desktop app (Cmd/Ctrl+A, then Cmd/Ctrl+C).
//
// Otherwise, without credentials it uses Spotify's public embed pages, which only list the
// first 100 tracks. With a (free) Spotify developer app it lists the whole
// playlist through the Web API. Provide its credentials either as
// SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET env vars or in
// .spotify-credentials.json: { "clientId": "...", "clientSecret": "..." }.
//
// Each track's release date and 30-second preview URL come from its embed page.
// Spotify dates are often those of a remaster/compilation, so
// data/year-overrides.json (keyed by cleaned title) corrects them.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_PLAYLIST = '7gzx60HLzeaDcopqwvdW7G';
const root = new URL('..', import.meta.url);

const tracksFlag = process.argv.indexOf('--tracks');
const tracksFile = tracksFlag !== -1 ? process.argv[tracksFlag + 1] : null;
const arg = (tracksFlag === -1 && process.argv[2]) || DEFAULT_PLAYLIST;
const playlistId = arg.match(/playlist[/:]([A-Za-z0-9]{22})/)?.[1] || arg;

async function embedEntity(kind, id) {
  let html;
  for (let attempt = 1; ; attempt++) {
    // Spotify sometimes 5xxs or drops the connection; retry those.
    try {
      const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) throw Object.assign(new Error(`${kind} ${id}: HTTP ${res.status}`), { retry: res.status >= 500 });
      html = await res.text();
      break;
    } catch (err) {
      if (attempt >= 3 || err.retry === false) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
  if (!json) throw new Error(`${kind} ${id}: no embed data found`);
  return JSON.parse(json).props.pageProps.state.data.entity;
}

// "Zombie - 2025 Remastered" -> "Zombie", "Yeah! (feat. Lil Jon)" -> "Yeah!"
function cleanTitle(title) {
  return title
    .replace(/\s+-\s+(.*(remaster|version|mix|edit|mono|stereo|live|from\b).*)$/i, '')
    .replace(/\s+\((feat|with)\.? [^)]*\)/i, '')
    .replace(/\s+\((love theme )?from [^)]*\)/i, '')
    .replace(/^(.+?)\s+-\s+(.+)$/, '$1 ($2)')
    .trim();
}

// Spotify lists duos as separate artists ("Macklemore, Ryan Lewis, Macklemore & Ryan Lewis").
function cleanArtist(artists) {
  const names = artists.map((a) => a.name);
  const combined = names.find((n) => / & /.test(n) && n.split(' & ').every((p) => names.includes(p)));
  if (combined) return names.filter((n) => !combined.split(' & ').includes(n)).join(', ');
  return names.join(', ');
}

async function credentials() {
  const { SPOTIFY_CLIENT_ID: clientId, SPOTIFY_CLIENT_SECRET: clientSecret } = process.env;
  if (clientId && clientSecret) return { clientId, clientSecret };
  const file = new URL('.spotify-credentials.json', root);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  return null;
}

// All track ids in the playlist, via the Web API (client-credentials flow).
async function apiTrackIds({ clientId, clientSecret }) {
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!tokenRes.ok) throw new Error(`Spotify login failed: HTTP ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token: token } = await tokenRes.json();

  const ids = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(id,type,is_local))`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Playlist request failed: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    for (const { track } of page.items) {
      if (track?.id && track.type === 'track' && !track.is_local) ids.push(track.id);
    }
    url = page.next;
  }
  return ids;
}

const overrides = JSON.parse(await readFile(new URL('data/year-overrides.json', root), 'utf8'));
const creds = await credentials();
let trackIds;
if (tracksFile) {
  const text = await readFile(tracksFile, 'utf8');
  trackIds = [...text.matchAll(/track[/:]([A-Za-z0-9]{22})/g)].map((m) => m[1]);
  console.error(`${tracksFile}: ${new Set(trackIds).size} unique tracks`);
} else if (creds) {
  trackIds = await apiTrackIds(creds);
  console.error(`Playlist ${playlistId}: ${trackIds.length} tracks via the Web API`);
} else {
  const playlist = await embedEntity('playlist', playlistId);
  trackIds = playlist.trackList.map((t) => t.uri.split(':').pop());
  console.error(`Playlist "${playlist.name}": ${trackIds.length} tracks via embed (add Spotify credentials for more)`);
}

// Playlists often hold the same song twice (album + single, remaster, soundtrack).
const songKey = (title, artists) =>
  `${title.toLowerCase().replace(/[^a-z0-9]/g, '')}|${artists.map((a) => a.name.toLowerCase()).sort().join(',')}`;
const exclude = new Set(overrides._exclude || []);
const seen = new Set();

const songs = [];
for (const id of new Set(trackIds)) {
  if (exclude.has(id)) {
    console.error(`  skip ${id}: excluded in year-overrides.json`);
    continue;
  }
  try {
    const t = await embedEntity('track', id);
    const title = cleanTitle(t.name);
    const spotifyYear = Number(t.releaseDate?.isoString?.slice(0, 4));
    const year = overrides[title] ?? spotifyYear;
    const key = songKey(title, t.artists);
    if (seen.has(key)) {
      console.error(`  skip ${title}: duplicate`);
      continue;
    }
    seen.add(key);
    if (!year || !t.audioPreview?.url) {
      console.error(`  skip ${title}: ${!year ? 'no year' : 'no preview'}`);
      continue;
    }
    songs.push({ id, title, artist: cleanArtist(t.artists), year, preview: t.audioPreview.url });
    console.error(`  ${year}${overrides[title] ? '*' : ' '} ${songs.at(-1).artist} – ${title}`);
  } catch (err) {
    console.error(`  skip ${id}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 150));
}

await writeFile(new URL('data/songs.json', root), JSON.stringify(songs, null, 1) + '\n');
console.error(`Wrote ${songs.length} songs to data/songs.json (* = year overridden)`);
