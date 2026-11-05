// Hitster Night client. The same page is the host screen (/host, plays the music)
// and the player view on each phone (which plays it too if the host turns on
// "Play on every phone"). All game logic lives on the server; this
// file renders the state it receives and posts the player's moves.

const IS_HOST = location.pathname === '/host' || new URLSearchParams(location.search).has('host');
const ID_KEY = 'hitster-night-player';
const MUTE_KEY = 'hitster-night-muted';

const app = document.getElementById('app');
const audio = document.getElementById('audio');
document.body.classList.toggle('host', IS_HOST);
audio.muted = !IS_HOST && storageGet(MUTE_KEY) === '1';

let myId = IS_HOST ? null : storageGet(ID_KEY);
let view = null;
let source = null;
let ui = {
  offline: false,
  menu: false,
  confirmQuit: false,
  stealPick: null, // slot a would-be stealer tapped, before confirming
  pickRound: null,
  joinName: '',
  soundBlocked: false,
};

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Without storage a reload just means re-joining under a new name.
  }
}

// ---------- server connection ----------

function connect() {
  source?.close();
  const params = IS_HOST ? 'host=1' : myId ? `id=${encodeURIComponent(myId)}` : '';
  const es = new EventSource(`/events?${params}`);
  source = es;
  es.onmessage = (e) => {
    if (es !== source) return; // a stale connection from before joining
    ui.offline = false;
    view = JSON.parse(e.data);
    onView();
  };
  es.onerror = () => {
    if (es !== source) return;
    ui.offline = true;
    renderOffline();
  };
}

async function act(type, args = {}) {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: myId, host: IS_HOST, type, args }),
    });
    const data = await res.json();
    if (data.error) {
      toast(esc(data.error));
      return undefined;
    }
    return data.value;
  } catch {
    toast('Connection problem — try again');
    return undefined;
  }
}

function onView() {
  if (!IS_HOST && myId && !view.you) {
    // Our player no longer exists (removed by the host, or the server was reset).
    myId = null;
    storageSet(ID_KEY, null);
  }
  if (ui.pickRound !== view.round || view.phase !== 'steal') {
    ui.stealPick = null;
    ui.pickRound = view.round;
  }
  syncAudio();
  render();
}

// ---------- audio ----------

let audioRound = null;
let audioReplay = 0;

function syncAudio() {
  const a = view.audio;
  if (!a) {
    if (audioRound !== null) {
      audio.pause();
      audioRound = null;
    }
    return;
  }
  if (a.round !== audioRound) {
    audioRound = a.round;
    audioReplay = a.replay;
    audio.src = a.preview;
    playAudio();
  } else if (a.replay !== audioReplay) {
    audioReplay = a.replay;
    audio.currentTime = 0;
    playAudio();
  }
}

function playAudio() {
  audio
    .play()
    .then(() => {
      if (ui.soundBlocked) {
        ui.soundBlocked = false;
        render();
      }
    })
    .catch((err) => {
      // Browsers block sound until the page has been tapped once.
      if (err.name === 'NotAllowedError') {
        ui.soundBlocked = true;
        render();
      }
    });
}

audio.addEventListener('play', syncRecord);
audio.addEventListener('pause', syncRecord);
audio.addEventListener('ended', syncRecord);
audio.addEventListener('timeupdate', () => {
  const bar = document.querySelector('.progress > div');
  if (bar && audio.duration) bar.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
});
audio.addEventListener('error', () => {
  if (!IS_HOST || audioRound == null || !audio.getAttribute('src')) return;
  toast("That song's preview won't play — drawing another");
  act('badAudio', { round: audioRound });
});

function syncRecord() {
  const rec = document.querySelector('.record:not(.mini)');
  if (!rec) return;
  rec.classList.toggle('spinning', !audio.paused);
  rec.querySelector('.icon').textContent = audio.paused ? '▶' : '❚❚';
}

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const playerById = (id) => view.players.find((p) => p.id === id);
const nameOf = (id) => esc(playerById(id)?.name ?? '?');
const coin = '<span class="coin">●</span>';

function cardColor(year) {
  const hue = (((year - 1950) * 5) % 360 + 360) % 360;
  return `hsl(${hue} 85% 68%)`;
}

function cardHTML(song, extraClass = '') {
  return `<div class="card ${extraClass}" style="background:${cardColor(song.year)}">
    <div class="artist">${esc(song.artist)}</div>
    <div class="year">${song.year}</div>
    <div class="title">${esc(song.title)}</div>
  </div>`;
}

// mode: 'readonly' | 'place' (active player picks) | 'steal' (others pick a free spot)
function timelineHTML(player, { mode = 'readonly', chosen = null, steals = [], picked = null, correct = [], highlight = null } = {}) {
  const stealAt = new Map(steals.map((s) => [s.slot, nameOf(s.player)]));
  const parts = [];
  for (let i = 0; i <= player.cards.length; i++) {
    const isChosen = chosen === i;
    const isStolen = stealAt.has(i);
    const disabled = mode === 'readonly' || (mode === 'steal' && (isChosen || isStolen));
    const classes = [
      'slot',
      isChosen && 'chosen',
      isStolen && 'stolen',
      picked === i && 'picked',
      correct.includes(i) && 'correct',
    ].filter(Boolean);
    const label = isChosen ? '?' : isStolen ? stealAt.get(i) : picked === i ? '✓' : mode === 'readonly' ? '' : '+';
    const action = mode === 'place' ? 'place' : 'pick-steal';
    parts.push(
      `<button class="${classes.join(' ')}" data-action="${action}" data-slot="${i}" ${disabled ? 'disabled' : ''} aria-label="Spot ${i + 1}">${label}</button>`,
    );
    if (i < player.cards.length) {
      const card = player.cards[i];
      parts.push(cardHTML(card, card.id === highlight ? 'new' : ''));
    }
  }
  return `<div class="timeline ${mode === 'readonly' ? 'readonly' : ''}">${parts.join('')}</div>`;
}

function scoresHTML() {
  return `<div class="scores">${view.players
    .map(
      (p) => `<div class="score ${p.id === view.turn ? 'active' : ''} ${p.id === view.you ? 'me' : ''}">
        <div class="name"><span class="dot ${p.online ? '' : 'off'}"></span>${esc(p.name)}</div>
        <div class="meta">🎵 ${p.cards.length}/${view.target} · ${coin} ${p.tokens}</div>
      </div>`,
    )
    .join('')}</div>`;
}

function revealCardHTML(song) {
  return `<div class="reveal-card" style="background:${cardColor(song.year)}">
    <div>${esc(song.artist)}</div>
    <div class="year">${song.year}</div>
    <div class="title">${esc(song.title)}</div>
  </div>`;
}

function verdictHTML() {
  const r = view.result;
  const active = nameOf(view.turn);
  if (r.kind === 'good') return `<div class="verdict good">✔ ${active} got it!</div>`;
  if (r.kind === 'steal') return `<div class="verdict steal">🏴‍☠️ Stolen by ${nameOf(r.player)}!</div>`;
  return `<div class="verdict bad">✘ Wrong spot — the card is discarded</div>`;
}

// After the reveal, show the timeline the card went into (or the active one, with the right spots).
function revealTimelineHTML() {
  const r = view.result;
  const owner = playerById(r.player ?? view.turn);
  if (!owner) return '';
  const label = `<p class="center muted">${esc(owner.name)}'s timeline</p>`;
  return label + timelineHTML(owner, {
    highlight: r.player ? view.song.id : null,
    correct: r.kind === 'bad' ? r.correctSlots : [],
  });
}

function winnerHTML() {
  const names = view.winners.map(nameOf).join(' & ');
  const ranked = [...view.players].sort((a, b) => b.cards.length - a.cards.length);
  return `<div class="winner">🏆</div>
    <h1 class="center logo">${names} win${view.winners.length > 1 ? '' : 's'}!</h1>
    ${ranked
      .map(
        (p) => `<div class="panel"><div class="row spread"><h3 style="margin:0">${esc(p.name)}</h3>
          <span class="muted">${p.cards.length} cards</span></div>${timelineHTML(p)}</div>`,
      )
      .join('')}`;
}

// ---------- player screens ----------

function joinHTML() {
  const inProgress = view.phase !== 'lobby' && view.phase !== 'won';
  return `
    <div class="center" style="padding:32px 0 16px">
      <h1 class="logo">Hitster Night</h1>
      <p class="muted">Listen to the song. Put it in the right spot in your timeline.</p>
    </div>
    <form class="panel stack" id="join-form">
      <h3>What's your name?</h3>
      <input type="text" id="join-name" maxlength="20" autocomplete="off" autocapitalize="words" placeholder="Your name" value="${esc(ui.joinName)}">
      <button class="primary" style="width:100%">Join game</button>
      ${inProgress ? '<p class="muted">A game is in progress — you\'ll jump in with a starting card.</p>' : ''}
    </form>
    <div id="join-players">${joinPlayersHTML()}</div>`;
}

function joinPlayersHTML() {
  if (!view.players.length) return '';
  return `<p class="muted center">Already here: ${view.players.map((p) => esc(p.name)).join(', ')}</p>`;
}

// Phones only get audio when the host plays the song on every phone.
function phoneSoundHTML() {
  if (!view.audio) return '';
  return `<div class="center" style="margin-top:16px">
    <button class="small ghost" data-action="toggle-mute">${audio.muted ? '🔇 Unmute this phone' : '🔊 Mute this phone'}</button>
  </div>`;
}

function playerHTML() {
  if (!view.you) return joinHTML();
  const me = playerById(view.you);
  const active = playerById(view.turn);
  const myTurn = view.turn === view.you;
  const top = `<div class="row spread" style="margin-bottom:12px">
      <h2 class="logo" style="margin:0">Hitster Night</h2>
      <span class="muted">${esc(me.name)}</span>
    </div>${scoresHTML()}`;

  return playerPhaseHTML(me, active, myTurn, top) + (view.phase === 'listen' || view.phase === 'steal' ? phoneSoundHTML() : '');
}

function playerPhaseHTML(me, active, myTurn, top) {
  switch (view.phase) {
    case 'lobby':
      return `${top}
        <div class="banner"><h2>You're in, ${esc(me.name)}!</h2>
        <p class="muted">Waiting for the host to start the game…</p></div>
        <div class="panel"><h3>First to ${view.target} cards wins</h3>
        ${view.soundEverywhere ? '<p>🔊 The music plays on your phone too.</p>' : ''}
        <p>Playlists: ${view.playlists.filter((pl) => pl.enabled).map((pl) => esc(pl.name)).join(', ') || '—'} (${view.songCount} songs)</p>
        <p class="muted">You start with ${view.rules.startTokens} ${coin} tokens. Name the title &amp; artist to earn more.
        Spend ${view.rules.skipCost} to skip a song, ${view.rules.stealCost} to steal, ${view.rules.buyCost} to buy a free card.</p></div>`;

    case 'listen':
      if (myTurn) {
        return `${top}
          <div class="banner"><h2 class="your-turn">Your turn!</h2>
          <p class="muted">Listen to the song, then tap where it fits in your timeline.</p></div>
          ${timelineHTML(me, { mode: 'place', chosen: view.slot })}
          <div class="stack center">
            <button class="primary" data-action="lock" ${view.slot == null ? 'disabled' : ''}>Lock it in</button>
            <div class="row centered">
              <button class="small" data-action="replayAudio">↺ Replay song</button>
              <button class="small" data-action="skip" ${me.tokens < view.rules.skipCost ? 'disabled' : ''}>Skip (−${view.rules.skipCost} ${coin})</button>
              <button class="small" data-action="buy" ${me.tokens < view.rules.buyCost ? 'disabled' : ''}>Buy card (−${view.rules.buyCost} ${coin})</button>
            </div>
          </div>`;
      }
      return `${top}
        <div class="banner"><h2>${esc(active.name)}'s turn</h2>
        <p class="muted">Listen along — they're picking a spot.</p></div>
        ${timelineHTML(active, { chosen: view.slot })}
        <p class="center muted">Your timeline</p>
        ${timelineHTML(me)}`;

    case 'steal': {
      const mySteal = view.steals.find((s) => s.player === view.you);
      if (myTurn) {
        return `${top}
          <div class="banner"><h2>Locked in!</h2>
          <p class="muted">The others can steal now. The host will reveal the card.</p></div>
          ${timelineHTML(me, { chosen: view.slot, steals: view.steals })}`;
      }
      if (!mySteal && me.tokens >= view.rules.stealCost) {
        return `${top}
          <div class="banner"><h2>Steal?</h2>
          <p class="muted">Think ${esc(active.name)} got it wrong? Pick a different spot.
          If they're wrong and you're right, the card is yours.</p></div>
          ${timelineHTML(active, { mode: 'steal', chosen: view.slot, steals: view.steals, picked: ui.stealPick })}
          <div class="center"><button class="primary" data-action="steal" ${ui.stealPick == null ? 'disabled' : ''}>
            Steal here (−${view.rules.stealCost} ${coin})</button></div>`;
      }
      return `${top}
        <div class="banner"><h2>${mySteal ? 'Steal placed!' : `${esc(active.name)} locked in`}</h2>
        <p class="muted">Waiting for the host to reveal…</p></div>
        ${timelineHTML(active, { chosen: view.slot, steals: view.steals })}`;
    }

    case 'reveal': {
      const r = view.result;
      const personal =
        r.player === view.you && !myTurn ? '<p class="center">🎉 You stole it — it\'s in your timeline!</p>' : '';
      return `${top}
        ${revealCardHTML(view.song)}
        ${verdictHTML()}
        ${personal}
        ${revealTimelineHTML()}
        <div class="stack center">
          ${view.named ? `<p>+1 ${coin} for ${myTurn ? 'you' : esc(active.name)} for naming it — nice!</p>` : ''}
          <p class="muted">Waiting for the host to play the next song…</p>
          <p><a class="muted" href="https://open.spotify.com/track/${view.song.id}" target="_blank" rel="noopener">Open in Spotify ↗</a></p>
        </div>`;
    }

    case 'won':
      return `${winnerHTML()}<p class="center muted">Waiting for the host to start another game…</p>`;
  }
  return '';
}

// ---------- host screens ----------

function joinUrl() {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  return local && view.joinUrls.length ? view.joinUrls[0] : location.origin;
}

function soundSettingHTML() {
  return `<label class="playlist ${view.soundEverywhere ? 'on' : ''}">
      <input type="checkbox" data-setting="soundEverywhere" ${view.soundEverywhere ? 'checked' : ''}>
      <span class="pl-name">Play on every phone</span>
      <span class="muted">not just here</span>
    </label>`;
}

function hostMenuHTML() {
  return `<div class="row spread" style="margin-bottom:12px">
      <h2 class="logo" style="margin:0">Hitster Night</h2>
      <button class="small ghost" data-action="menu">${ui.menu ? 'Close' : 'Menu'}</button>
    </div>
    ${
      ui.menu
        ? `<div class="panel stack">
            <p class="muted">Join at <b>${esc(joinUrl())}</b></p>
            ${soundSettingHTML()}
            <div class="chips">${view.players
              .map((p) => `<span class="chip">${esc(p.name)}<button data-action="kick" data-player="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button></span>`)
              .join('')}</div>
            ${
              ui.confirmQuit
                ? `<div class="row"><span>End this game?</span>
                    <button class="small primary" data-action="newGame">Yes, back to lobby</button>
                    <button class="small" data-action="cancel-quit">No</button></div>`
                : `<button class="small" data-action="ask-quit">End game</button>`
            }
          </div>`
        : ''
    }`;
}

function hostLobbyHTML() {
  const url = joinUrl();
  return `
    <div class="center" style="padding:16px 0">
      <h1 class="logo">Hitster Night</h1>
      <p class="muted">${view.songCount} songs · first to ${view.target} cards wins</p>
    </div>
    <div class="panel join-box">
      <div class="qr" id="qr" data-url="${esc(url)}"></div>
      <div class="center">
        <p class="muted">Scan or open on your phone (same Wi-Fi):</p>
        <div class="join-url">${esc(url)}</div>
      </div>
    </div>
    <div class="panel">
      <h3>Players (${view.players.length})</h3>
      ${
        view.players.length
          ? `<div class="chips">${view.players
              .map(
                (p) => `<span class="chip"><span class="dot ${p.online ? '' : 'off'}"></span>${esc(p.name)}
                  <button data-action="kick" data-player="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button></span>`,
              )
              .join('')}</div>`
          : '<p class="muted">Waiting for players to join…</p>'
      }
    </div>
    <div class="panel">
      <h3>Playlists</h3>
      <div class="playlists">${view.playlists
        .map(
          (pl) => `<label class="playlist ${pl.enabled ? 'on' : ''}">
            <input type="checkbox" data-playlist="${esc(pl.id)}" ${pl.enabled ? 'checked' : ''}>
            <span class="pl-name">${esc(pl.name)}</span>
            <span class="muted">${pl.count} songs</span>
          </label>`,
        )
        .join('')}</div>
      ${view.songCount ? '' : '<p class="muted" style="margin-top:12px">Pick at least one playlist.</p>'}
    </div>
    <div class="panel">
      <h3>Sound</h3>
      ${soundSettingHTML()}
    </div>
    <div class="panel">
      <h3>Cards to win</h3>
      <div class="choice">${view.rules.targets
        .map((n) => `<button class="${view.target === n ? 'on' : ''}" data-action="setTarget" data-target="${n}">${n}</button>`)
        .join('')}</div>
    </div>
    <div class="center"><button class="primary" data-action="start" ${view.players.length && view.songCount ? '' : 'disabled'}>Start game</button></div>`;
}

function hostRecordHTML() {
  return `<div class="player-box">
    <button class="record ${audio.paused ? '' : 'spinning'}" data-action="toggle-audio" aria-label="Play or pause">
      <span class="icon">${audio.paused ? '▶' : '❚❚'}</span>
    </button>
    <div class="progress"><div></div></div>
  </div>`;
}

function hostGameHTML() {
  const active = playerById(view.turn);
  const top = hostMenuHTML() + scoresHTML();
  if (view.phase === 'reveal') {
    return `${top}
      ${revealCardHTML(view.song)}
      ${verdictHTML()}
      ${revealTimelineHTML()}
      <div class="stack center">
        ${
          view.named
            ? `<p>+1 ${coin} for ${esc(active.name)} for naming it</p>`
            : `<button data-action="named" ${active.tokens >= view.rules.maxTokens ? 'disabled' : ''}>
                ${esc(active.name)} guessed the title &amp; artist: +1 ${coin}${active.tokens >= view.rules.maxTokens ? ' (max reached)' : ''}</button>`
        }
        <button class="primary" data-action="next">Next song →</button>
      </div>`;
  }
  const status =
    view.phase === 'listen'
      ? view.slot == null
        ? `${esc(active.name)} is listening…`
        : `${esc(active.name)} is thinking about it…`
      : view.steals.length
        ? `Steal attempts: ${view.steals.map((s) => nameOf(s.player)).join(', ')}`
        : 'Locked in! Anyone want to steal?';
  return `${top}
    <div class="banner"><h2>${esc(active.name)}'s turn</h2><p class="muted">${status}</p></div>
    ${hostRecordHTML()}
    ${timelineHTML(active, { chosen: view.slot, steals: view.phase === 'steal' ? view.steals : [] })}
    <div class="stack center">
      ${view.phase === 'steal' ? '<button class="primary" data-action="reveal">Reveal!</button>' : ''}
      <button class="small ghost" data-action="pass">Pass ${esc(active.name)}'s turn</button>
    </div>`;
}

function hostHTML() {
  switch (view.phase) {
    case 'lobby':
      return hostLobbyHTML();
    case 'won':
      return `${winnerHTML()}
        <div class="stack center">
          <button class="primary" data-action="start">Play again</button>
          <button data-action="newGame">Back to lobby</button>
        </div>`;
    default:
      return hostGameHTML();
  }
}

// ---------- rendering ----------

function render() {
  if (!view) return;
  // Don't wipe the name field while someone is typing in it.
  if (!IS_HOST && !view.you && document.getElementById('join-form')) {
    document.getElementById('join-players').innerHTML = joinPlayersHTML();
    return;
  }
  app.innerHTML = IS_HOST ? hostHTML() : playerHTML();
  if (ui.soundBlocked && view.audio && !audio.muted) {
    app.insertAdjacentHTML(
      'beforeend',
      `<div class="sound-gate"><button class="primary" data-action="enable-sound">🔊 Tap to play the music</button></div>`,
    );
  }
  renderQr();
  renderOffline();
  syncRecord();
}

function renderQr() {
  const el = document.getElementById('qr');
  if (!el) return;
  if (!window.QRCode) {
    el.remove();
    return;
  }
  new window.QRCode(el, { text: el.dataset.url, width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.M });
}

function renderOffline() {
  let bar = document.querySelector('.offline');
  if (ui.offline && !bar) {
    bar = document.createElement('div');
    bar.className = 'offline';
    bar.textContent = 'Reconnecting to the game…';
    document.body.append(bar);
  } else if (!ui.offline && bar) {
    bar.remove();
  }
}

function toast(html) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  document.body.append(el);
  setTimeout(() => el.remove(), 2800);
}

// ---------- events ----------

const actions = {
  place: (d) => act('place', { slot: Number(d.slot) }),
  lock: () => act('lock'),
  reveal: () => act('reveal'),
  named: () => act('named'),
  next: () => act('next'),
  skip: () => act('skip'),
  replayAudio: () => act('replayAudio'),
  start: () => act('start'),
  newGame: () => {
    ui.menu = false;
    ui.confirmQuit = false;
    return act('newGame');
  },
  pass: () => act('pass'),
  kick: (d) => act('kick', { player: d.player }),
  setTarget: (d) => act('setTarget', { target: Number(d.target) }),
  async buy() {
    const card = await act('buy');
    if (card) toast(`Bought: ${esc(card.title)} (${card.year})`);
  },
  'pick-steal'(d) {
    ui.stealPick = Number(d.slot);
    render();
  },
  async steal() {
    if (ui.stealPick == null) return;
    await act('steal', { slot: ui.stealPick });
  },
  menu() {
    ui.menu = !ui.menu;
    ui.confirmQuit = false;
    render();
  },
  'ask-quit'() {
    ui.confirmQuit = true;
    render();
  },
  'cancel-quit'() {
    ui.confirmQuit = false;
    render();
  },
  'toggle-audio'() {
    if (audio.paused) playAudio();
    else audio.pause();
  },
  'enable-sound'() {
    playAudio();
  },
  'toggle-mute'() {
    audio.muted = !audio.muted;
    storageSet(MUTE_KEY, audio.muted ? '1' : null);
    if (!audio.muted && audio.paused && view.audio) playAudio();
    else render();
  },
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  actions[btn.dataset.action]?.(btn.dataset);
});

app.addEventListener('input', (e) => {
  if (e.target.id === 'join-name') ui.joinName = e.target.value;
});

app.addEventListener('change', (e) => {
  if (e.target.dataset.setting === 'soundEverywhere') return act('setSoundEverywhere', { on: e.target.checked });
  if (!e.target.dataset.playlist) return;
  const playlists = [...app.querySelectorAll('[data-playlist]:checked')].map((el) => el.dataset.playlist);
  act('setPlaylists', { playlists });
});

app.addEventListener('submit', async (e) => {
  if (e.target.id !== 'join-form') return;
  e.preventDefault();
  const name = ui.joinName.trim();
  if (!name) return toast('Type your name first');
  const id = await act('join', { name });
  if (!id) return;
  myId = id;
  storageSet(ID_KEY, id);
  connect();
});

connect();
