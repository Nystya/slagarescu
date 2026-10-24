#!/usr/bin/env node
// Hitster Night server: serves the web app and keeps the shared game state.
//
//   node server.js            # then open http://localhost:3000/host on the laptop
//   PORT=8080 node server.js
//
// Phones on the same Wi-Fi join via the http://<lan-ip>:3000 address printed below.
// Clients receive state over Server-Sent Events and send moves as POST /api/action.

import http from 'node:http';
import os from 'node:os';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, GameError } from './game.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const SAVE_FILE = join(ROOT, 'data', 'game-state.json');
const PORT = Number(process.env.PORT) || 3000;

const songs = JSON.parse(readFileSync(join(ROOT, 'data', 'songs.json'), 'utf8'));
let saved = null;
if (existsSync(SAVE_FILE)) {
  try {
    saved = JSON.parse(readFileSync(SAVE_FILE, 'utf8'));
  } catch {
    console.warn('Ignoring unreadable saved game');
  }
}
const game = new Game(songs, saved);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

// ---------- live updates ----------

const clients = new Set(); // { res, id, host }

function viewFor(client) {
  const v = game.view(client);
  const online = new Set([...clients].map((c) => c.id).filter(Boolean));
  for (const p of v.players) p.online = online.has(p.id);
  v.joinUrls = lanAddresses();
  return v;
}

function send(client) {
  client.res.write(`data: ${JSON.stringify(viewFor(client))}\n\n`);
}

let saveTimer = null;
function broadcast() {
  for (const c of clients) send(c);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = `${SAVE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(game.state));
    await rename(tmp, SAVE_FILE);
  }, 200);
}

setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 20000);

// ---------- http ----------

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) throw new GameError('Request too large');
  }
  return JSON.parse(body || '{}');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function serveStatic(res, pathname) {
  if (pathname === '/' || pathname === '/host') pathname = '/index.html';
  const file = normalize(join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) return json(res, 404, { error: 'Not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const client = { res, id: url.searchParams.get('id') || null, host: url.searchParams.get('host') === '1' };
    clients.add(client);
    req.on('close', () => {
      clients.delete(client);
      broadcast(); // online status changed
    });
    broadcast();
    return;
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    try {
      const { id, host, type, args } = await readJson(req);
      const value = game.apply({ id: id || null, host: host === true }, type, args || {});
      broadcast();
      return json(res, 200, { ok: true, value: value ?? null });
    } catch (err) {
      if (err instanceof GameError || err instanceof SyntaxError) return json(res, 400, { error: err.message });
      console.error(err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);
  json(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses();
  console.log(`\n  Hitster Night is running with ${songs.length} songs.\n`);
  console.log(`  Host screen (this computer):  http://localhost:${PORT}/host`);
  if (lan.length) console.log(`  Players join on their phones: ${lan.join('  or  ')}`);
  else console.log('  No Wi-Fi address found — are you connected to a network?');
  console.log('');
});
