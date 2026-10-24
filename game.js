// Server-authoritative Hitster game state. Pure logic, no I/O.

import { randomUUID } from 'node:crypto';

export const RULES = {
  startTokens: 2,
  maxTokens: 5,
  skipCost: 1,
  stealCost: 1,
  buyCost: 3,
  maxPlayers: 10,
  targets: [5, 8, 10, 12],
};

export class GameError extends Error {}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Game {
  constructor(songs, saved = null) {
    this.songs = songs;
    this.state = saved || {
      phase: 'lobby',
      target: 10,
      players: [],
      deck: [],
      turn: 0,
      song: null,
      slot: null,
      steals: [],
      result: null,
      named: false,
      winners: [],
      round: 0, // bumps every time a new song is drawn, so hosts know to (re)load audio
      replay: 0,
    };
  }

  // ---------- helpers ----------

  player(id) {
    return this.state.players.find((p) => p.id === id);
  }

  active() {
    return this.state.players[this.state.turn];
  }

  isActive(id) {
    return this.active()?.id === id;
  }

  year(songIdx) {
    return this.songs[songIdx].year;
  }

  drawSong() {
    const s = this.state;
    if (!s.deck.length) {
      const used = new Set(s.players.flatMap((p) => p.cards));
      if (s.song != null) used.add(s.song);
      s.deck = shuffle(this.songs.map((_, i) => i).filter((i) => !used.has(i)));
    }
    return s.deck.pop() ?? null;
  }

  insertCard(player, songIdx) {
    const y = this.year(songIdx);
    const at = player.cards.findIndex((c) => this.year(c) > y);
    player.cards.splice(at === -1 ? player.cards.length : at, 0, songIdx);
  }

  // Slot i sits before cards[i]; slot cards.length is the far right.
  slotFits(cards, slot, year) {
    const before = cards[slot - 1];
    const after = cards[slot];
    return (before == null || this.year(before) <= year) && (after == null || year <= this.year(after));
  }

  startTurn(turn) {
    const s = this.state;
    s.turn = turn;
    s.phase = 'listen';
    s.slot = null;
    s.steals = [];
    s.result = null;
    s.named = false;
    s.song = this.drawSong();
    s.round += 1;
    if (s.song == null) this.finishByCount();
  }

  nextTurn() {
    const s = this.state;
    if (this.checkWin()) return;
    this.startTurn((s.turn + 1) % s.players.length);
  }

  finishByCount() {
    const s = this.state;
    const best = Math.max(...s.players.map((p) => p.cards.length));
    s.winners = s.players.filter((p) => p.cards.length === best).map((p) => p.id);
    s.phase = 'won';
  }

  checkWin() {
    const s = this.state;
    const winners = s.players.filter((p) => p.cards.length >= s.target).map((p) => p.id);
    if (!winners.length) return false;
    s.winners = winners;
    s.phase = 'won';
    return true;
  }

  reveal() {
    const s = this.state;
    const active = this.active();
    const year = this.year(s.song);
    const cards = active.cards;
    const correctSlots = cards
      .concat([null])
      .map((_, i) => i)
      .filter((i) => this.slotFits(cards, i, year));
    let result;
    if (this.slotFits(cards, s.slot, year)) {
      result = { kind: 'good', player: active.id };
    } else {
      const steal = s.steals.find((st) => this.slotFits(cards, st.slot, year));
      result = steal ? { kind: 'steal', player: steal.player } : { kind: 'bad', player: null };
    }
    result.correctSlots = correctSlots;
    result.slot = s.slot;
    if (result.player) this.insertCard(this.player(result.player), s.song);
    s.result = result;
    s.phase = 'reveal';
  }

  // ---------- actions ----------
  // Each returns an optional value; throws GameError on invalid moves.

  apply(actor, type, args = {}) {
    const fn = this.actions[type];
    if (!fn) throw new GameError(`Unknown action: ${type}`);
    return fn.call(this, actor, args);
  }

  actions = {
    join({ id }, { name }) {
      const s = this.state;
      const existing = id && this.player(id);
      if (existing) return existing.id;
      name = String(name || '').trim().slice(0, 20);
      if (!name) throw new GameError('Pick a name');
      if (s.players.length >= RULES.maxPlayers) throw new GameError('The game is full');
      if (s.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw new GameError('That name is taken');
      }
      const player = { id: randomUUID(), name, cards: [], tokens: RULES.startTokens };
      s.players.push(player);
      // Late joiners get their starting card straight away.
      if (s.phase !== 'lobby' && s.phase !== 'won') this.insertCard(player, this.drawSong());
      return player.id;
    },

    kick({ host }, { player }) {
      const s = this.state;
      if (!host) throw new GameError('Only the host can remove players');
      const idx = s.players.findIndex((p) => p.id === player);
      if (idx === -1) return;
      const wasActive = idx === s.turn;
      s.players.splice(idx, 1);
      s.steals = s.steals.filter((st) => st.player !== player);
      if (!s.players.length) {
        Object.assign(s, { phase: 'lobby', turn: 0, song: null });
        return;
      }
      if (s.phase === 'lobby' || s.phase === 'won') return;
      if (idx < s.turn) s.turn -= 1;
      if (wasActive) this.startTurn(s.turn % s.players.length);
    },

    setTarget({ host }, { target }) {
      if (!host) throw new GameError('Only the host can change settings');
      if (!RULES.targets.includes(target)) throw new GameError('Invalid target');
      if (this.state.phase !== 'lobby') throw new GameError('Game already started');
      this.state.target = target;
    },

    start({ host }) {
      const s = this.state;
      if (!host) throw new GameError('Only the host can start');
      if (s.phase !== 'lobby' && s.phase !== 'won') throw new GameError('Game already running');
      if (!s.players.length) throw new GameError('Nobody has joined yet');
      s.deck = shuffle(this.songs.map((_, i) => i));
      s.song = null;
      s.winners = [];
      for (const p of s.players) {
        p.cards = [];
        p.tokens = RULES.startTokens;
        this.insertCard(p, this.drawSong());
      }
      this.startTurn(0);
    },

    newGame({ host }) {
      if (!host) throw new GameError('Only the host can reset');
      const s = this.state;
      Object.assign(s, { phase: 'lobby', song: null, slot: null, steals: [], result: null, winners: [] });
      for (const p of s.players) {
        p.cards = [];
        p.tokens = RULES.startTokens;
      }
    },

    place({ id }, { slot }) {
      const s = this.state;
      if (s.phase !== 'listen' || !this.isActive(id)) throw new GameError("It's not your turn");
      if (!Number.isInteger(slot) || slot < 0 || slot > this.active().cards.length) throw new GameError('Invalid spot');
      s.slot = slot;
    },

    lock({ id }) {
      const s = this.state;
      if (s.phase !== 'listen' || !this.isActive(id)) throw new GameError("It's not your turn");
      if (s.slot == null) throw new GameError('Pick a spot first');
      s.phase = 'steal'; // the host reveals once any steals are in
    },

    steal({ id }, { slot }) {
      const s = this.state;
      const p = this.player(id);
      if (s.phase !== 'steal') throw new GameError('Too late to steal');
      if (!p || this.isActive(id)) throw new GameError("You can't steal your own card");
      if (p.tokens < RULES.stealCost) throw new GameError('Not enough tokens');
      if (s.steals.some((st) => st.player === id)) throw new GameError('You already stole');
      if (!Number.isInteger(slot) || slot < 0 || slot > this.active().cards.length) throw new GameError('Invalid spot');
      if (slot === s.slot || s.steals.some((st) => st.slot === slot)) throw new GameError('That spot is taken');
      p.tokens -= RULES.stealCost;
      s.steals.push({ player: id, slot });
    },

    reveal({ host }) {
      const s = this.state;
      if (s.phase !== 'steal') throw new GameError('Nothing to reveal');
      if (!host) throw new GameError('Only the host can reveal');
      this.reveal();
    },

    named({ host }) {
      const s = this.state;
      const p = this.active();
      if (s.phase !== 'reveal') throw new GameError('Not now');
      if (!host) throw new GameError('Only the host can award that');
      if (s.named) return;
      if (p.tokens >= RULES.maxTokens) throw new GameError('Already at max tokens');
      p.tokens += 1;
      s.named = true;
    },

    skip({ id }) {
      const s = this.state;
      const p = this.player(id);
      if (s.phase !== 'listen' || !this.isActive(id)) throw new GameError("It's not your turn");
      if (p.tokens < RULES.skipCost) throw new GameError('Not enough tokens');
      p.tokens -= RULES.skipCost;
      this.startTurn(s.turn);
    },

    buy({ id }) {
      const s = this.state;
      const p = this.player(id);
      if (s.phase !== 'listen' || !this.isActive(id)) throw new GameError("It's not your turn");
      if (p.tokens < RULES.buyCost) throw new GameError('Not enough tokens');
      const card = this.drawSong();
      if (card == null) throw new GameError('The deck is empty');
      p.tokens -= RULES.buyCost;
      this.insertCard(p, card);
      this.checkWin();
      return this.songInfo(card);
    },

    next({ host }) {
      const s = this.state;
      if (s.phase !== 'reveal') throw new GameError('Not now');
      if (!host) throw new GameError('Only the host can move on');
      this.nextTurn();
    },

    // Host escape hatch for a player who wandered off mid-turn.
    pass({ host }) {
      const s = this.state;
      if (!host) throw new GameError('Only the host can pass a turn');
      if (s.phase !== 'listen' && s.phase !== 'steal') throw new GameError('Not now');
      for (const st of s.steals) this.player(st.player).tokens += RULES.stealCost;
      this.nextTurn();
    },

    replayAudio({ id, host }) {
      const s = this.state;
      if (!host && !this.isActive(id)) throw new GameError('Only the active player can replay');
      s.replay += 1;
    },

    // Host reports a preview that won't play; swap in another song for free.
    badAudio({ host }, { round }) {
      const s = this.state;
      if (!host) throw new GameError('Only the host reports audio');
      if (round !== s.round || (s.phase !== 'listen' && s.phase !== 'steal')) return;
      for (const st of s.steals) this.player(st.player).tokens += RULES.stealCost;
      this.startTurn(s.turn);
    },
  };

  // ---------- views ----------

  songInfo(idx) {
    const { id, title, artist, year } = this.songs[idx];
    return { id, title, artist, year };
  }

  // What a client may see. The current song stays secret until the reveal.
  view({ host = false, id = null } = {}) {
    const s = this.state;
    const v = {
      phase: s.phase,
      target: s.target,
      rules: RULES,
      songCount: this.songs.length,
      you: id && this.player(id) ? id : null,
      turn: s.players[s.turn]?.id ?? null,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        tokens: p.tokens,
        cards: p.cards.map((c) => this.songInfo(c)),
      })),
      slot: s.slot,
      steals: s.steals,
      result: s.result,
      named: s.named,
      winners: s.winners,
      round: s.round,
      song: s.phase === 'reveal' && s.song != null ? this.songInfo(s.song) : null,
    };
    if (host && s.song != null && s.phase !== 'lobby' && s.phase !== 'won') {
      v.audio = { round: s.round, replay: s.replay, preview: this.songs[s.song].preview };
    }
    return v;
  }
}
