#!/usr/bin/env node
// Builds data/songs/<id>.json for the playlists listed in data/playlists.json.
//
//   node tools/fetch-playlist.mjs            # every playlist
//   node tools/fetch-playlist.mjs manele     # just these playlist ids
//
// Each playlist entry names a file of track links in data/, e.g. pasted after
// selecting every song of a playlist in the Spotify desktop app
// (Cmd/Ctrl+A, then Cmd/Ctrl+C). Spotify's public embed only lists the first
// 100 tracks of a playlist and its Web API needs a Premium developer account,
// so the link list is the reliable way to get them all.
//
// Each track's release date and 30-second preview URL come from its public
// embed page. Spotify dates are often those of a remaster/compilation, so
// data/year-overrides.json (keyed by cleaned title) corrects them.

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const dataFile = (name) => new URL(`data/${name}`, root);

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

// Playlists often hold the same song twice (album + single, remaster, soundtrack).
const songKey = (title, artists) =>
  `${title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}|${artists.map((a) => a.name.toLowerCase()).sort().join(',')}`;

async function buildPlaylist(playlist, overrides) {
  const text = await readFile(dataFile(playlist.tracks), 'utf8');
  const trackIds = new Set([...text.matchAll(/track[/:]([A-Za-z0-9]{22})/g)].map((m) => m[1]));
  console.error(`${playlist.name}: ${trackIds.size} unique tracks in data/${playlist.tracks}`);

  const exclude = new Set(overrides._exclude || []);
  const seen = new Set();
  const songs = [];
  for (const id of trackIds) {
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

  await mkdir(dataFile('songs'), { recursive: true });
  await writeFile(dataFile(`songs/${playlist.id}.json`), JSON.stringify(songs, null, 1) + '\n');
  console.error(`Wrote ${songs.length} songs to data/songs/${playlist.id}.json (* = year overridden)\n`);
}

const playlists = JSON.parse(await readFile(dataFile('playlists.json'), 'utf8'));
const overrides = JSON.parse(await readFile(dataFile('year-overrides.json'), 'utf8'));
const wanted = process.argv.slice(2);
const unknown = wanted.filter((id) => !playlists.some((p) => p.id === id));
if (unknown.length) {
  console.error(`Unknown playlist id(s): ${unknown.join(', ')}. Known: ${playlists.map((p) => p.id).join(', ')}`);
  process.exit(1);
}
for (const playlist of playlists) {
  if (!wanted.length || wanted.includes(playlist.id)) await buildPlaylist(playlist, overrides);
}
