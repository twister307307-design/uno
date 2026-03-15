const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const JWT_SECRET = process.env.JWT_SECRET || 'uno_secret_2024';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const users = {};
const rooms = {};

const COLORS = ['red', 'green', 'blue', 'yellow'];
const AVATARS = ['🎴','🃏','🎲','🎯','🎪','🎨','🎭','🎬','🎮','🕹️','🎸','🎺','🎻','🥁','🎹','🌈','⭐','🔥','💎','👑'];

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: '0', type: 'number' });
    for (let v = 1; v <= 9; v++) {
      deck.push({ color, value: String(v), type: 'number' });
      deck.push({ color, value: String(v), type: 'number' });
    }
    for (const special of ['skip', 'reverse', 'draw2']) {
      deck.push({ color, value: special, type: 'special' });
      deck.push({ color, value: special, type: 'special' });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild', type: 'wild' });
    deck.push({ color: 'wild', value: 'draw4', type: 'wild' });
  }
  return shuffle(deck);
}

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function canPlay(card, topCard, currentColor) {
  if (card.type === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function auth(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// AUTH
app.post('/api/register', async (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
  if (username.length < 3) return res.status(400).json({ error: 'Pseudo trop court (min 3)' });
  if (password.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (min 4)' });
  if (users[username]) return res.status(400).json({ error: 'Pseudo déjà pris' });
  const hash = await bcrypt.hash(password, 10);
  const chosen = AVATARS.includes(avatar) ? avatar : AVATARS[0];
  users[username] = { password: hash, avatar: chosen, wins: 0 };
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username, avatar: chosen });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const u = users[username];
  if (!u) return res.status(400).json({ error: 'Compte introuvable' });
  if (!await bcrypt.compare(password, u.password)) return res.status(400).json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username, avatar: u.avatar });
});

// GAME ROOM
class UnoRoom {
  constructor(code, host) {
    this.code = code; this.host = host;
    this.players = {}; // sid -> { username, avatar, hand, connected }
    this.playerOrder = []; // list of sids in turn order
    this.phase = 'lobby';
    this.deck = [];
    this.discard = [];
    this.currentColor = null;
    this.currentPlayerIdx = 0;
    this.direction = 1; // 1 = clockwise, -1 = counter
    this.drawPending = 0; // stacked draw2/draw4
    this.log = [];
    this.winner = null;
    this.mustSayUno = null; // sid who should say UNO
    this.unoSaid = {};
  }

  add(sid, username, avatar) {
    this.players[sid] = { username, avatar, hand: [], connected: true, saidUno: false };
  }
  del(sid) { delete this.players[sid]; this.playerOrder = this.playerOrder.filter(s => s !== sid); }
  count() { return Object.keys(this.players).length; }

  currentSid() { return this.playerOrder[this.currentPlayerIdx]; }

  nextTurn(skip = false) {
    const n = this.playerOrder.length;
    let steps = skip ? 2 : 1;
    this.currentPlayerIdx = ((this.currentPlayerIdx + this.direction * steps) % n + n) % n;
  }

  dealCards() {
    this.deck = createDeck();
    this.playerOrder = shuffle(Object.keys(this.players));
    Object.values(this.players).forEach(p => { p.hand = []; p.saidUno = false; });
    // Deal 7 cards each
    for (let i = 0; i < 7; i++) {
      this.playerOrder.forEach(sid => {
        this.players[sid].hand.push(this.deck.pop());
      });
    }
    // First card (no wild)
    let first;
    do { first = this.deck.pop(); } while (first.type === 'wild');
    this.discard = [first];
    this.currentColor = first.color;
    this.currentPlayerIdx = 0;
    this.direction = 1;
    this.drawPending = 0;

    // Apply first card effects
    if (first.value === 'skip') this.nextTurn(true);
    else if (first.value === 'reverse') { this.direction = -1; }
    else if (first.value === 'draw2') { this.drawPending = 2; this.nextTurn(); }
  }

  drawCard(sid) {
    if (this.deck.length === 0) {
      const top = this.discard.pop();
      this.deck = shuffle(this.discard);
      this.discard = [top];
    }
    const card = this.deck.pop();
    if (card) this.players[sid].hand.push(card);
    return card;
  }

  log_(msg, type = 'info') { this.log.push({ msg, type, t: Date.now() }); }

  state(forSid = null) {
    const players = {};
    this.playerOrder.forEach((sid, idx) => {
      const p = this.players[sid];
      if (!p) return;
      players[sid] = {
        username: p.username, avatar: p.avatar,
        handCount: p.hand.length, connected: p.connected,
        isHost: p.username === this.host,
        isCurrent: sid === this.currentSid(),
        saidUno: p.saidUno,
        hand: forSid === sid ? p.hand : null, // only your own hand
      };
    });
    return {
      code: this.code, host: this.host, phase: this.phase,
      players, playerOrder: this.playerOrder,
      topCard: this.discard[this.discard.length - 1] || null,
      currentColor: this.currentColor,
      currentPlayer: this.currentSid(),
      direction: this.direction,
      drawPending: this.drawPending,
      deckCount: this.deck.length,
      log: this.log.slice(-30),
      winner: this.winner,
      myHand: forSid ? (this.players[forSid]?.hand || []) : [],
    };
  }
}

const socketUsers = {};

io.on('connection', socket => {
  const bcast = code => {
    const r = rooms[code]; if (!r) return;
    Object.keys(r.players).forEach(sid => io.to(sid).emit('state', r.state(sid)));
  };

  socket.on('auth', ({ token }) => {
    const u = auth(token); if (!u) return socket.emit('auth_error');
    socketUsers[socket.id] = u.username;
    socket.emit('auth_ok', { username: u.username, avatar: users[u.username]?.avatar });
  });

  socket.on('create_room', ({ token }) => {
    const u = auth(token); if (!u) return;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const r = new UnoRoom(code, u.username);
    rooms[code] = r;
    r.add(socket.id, u.username, users[u.username]?.avatar || '🎴');
    socket.join(code);
    r.log_(`🏠 ${u.username} a créé le salon`, 'system');
    socket.emit('room_joined', { code });
    bcast(code);
  });

  socket.on('join_room', ({ token, code }) => {
    const u = auth(token); if (!u) return socket.emit('err', 'Non authentifié');
    const c = code?.toUpperCase();
    const r = rooms[c];
    if (!r) return socket.emit('err', 'Salon introuvable');
    if (r.phase !== 'lobby') return socket.emit('err', 'Partie déjà en cours');
    if (r.count() >= 8) return socket.emit('err', 'Salon plein (max 8)');
    if (Object.values(r.players).find(p => p.username === u.username)) return socket.emit('err', 'Déjà dans ce salon');
    r.add(socket.id, u.username, users[u.username]?.avatar || '🎴');
    socket.join(c);
    r.log_(`🚪 ${u.username} a rejoint`, 'system');
    socket.emit('room_joined', { code: c });
    bcast(c);
  });

  socket.on('start_game', ({ token, code }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r || r.host !== u.username) return socket.emit('err', 'Pas l\'hôte');
    if (r.count() < 2) return socket.emit('err', 'Minimum 2 joueurs !');
    r.dealCards();
    r.phase = 'playing';
    r.log_('🎴 La partie commence ! Bonne chance !', 'system');
    const cur = r.players[r.currentSid()];
    r.log_(`🎯 C'est au tour de ${cur?.username} de jouer`, 'turn');
    bcast(code);
  });

  socket.on('play_card', ({ token, code, cardIdx, chosenColor }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r || r.phase !== 'playing') return;
    const sid = Object.keys(r.players).find(s => r.players[s].username === u.username);
    if (!sid || r.currentSid() !== sid) return socket.emit('err', 'Pas votre tour !');

    const p = r.players[sid];
    const card = p.hand[cardIdx];
    if (!card) return socket.emit('err', 'Carte invalide');

    const top = r.discard[r.discard.length - 1];

    // Check if there's a draw pending - must play draw card or draw
    if (r.drawPending > 0) {
      if (card.value !== 'draw2' && card.value !== 'draw4') {
        return socket.emit('err', `Vous devez jouer un +2/+4 ou piocher ${r.drawPending} cartes !`);
      }
    }

    if (!canPlay(card, top, r.currentColor)) return socket.emit('err', 'Carte non jouable !');

    // Remove from hand
    p.hand.splice(cardIdx, 1);
    p.saidUno = false;
    r.discard.push(card);

    // Set color
    if (card.type === 'wild') {
      r.currentColor = chosenColor || 'red';
      r.log_(`🌈 ${u.username} joue ${card.value === 'draw4' ? '+4' : 'Joker'} et choisit ${colorName(r.currentColor)}`, 'play');
    } else {
      r.currentColor = card.color;
      r.log_(`${colorEmoji(card.color)} ${u.username} joue ${cardLabel(card)}`, 'play');
    }

    // Check UNO
    if (p.hand.length === 1) {
      r.mustSayUno = sid;
      r.log_(`⚠️ ${u.username} n'a plus qu'une carte !`, 'uno');
    }

    // Check win
    if (p.hand.length === 0) {
      r.phase = 'finished';
      r.winner = u.username;
      r.log_(`🏆 ${u.username} a gagné ! UNO !!! 🎉`, 'win');
      if (users[u.username]) users[u.username].wins = (users[u.username].wins || 0) + 1;
      bcast(code);
      return;
    }

    // Apply card effects
    if (card.value === 'skip') {
      const skippedSid = r.playerOrder[((r.currentPlayerIdx + r.direction) % r.playerOrder.length + r.playerOrder.length) % r.playerOrder.length];
      const skipped = r.players[skippedSid];
      r.log_(`⏭️ ${skipped?.username} passe son tour !`, 'effect');
      r.nextTurn(true);
    } else if (card.value === 'reverse') {
      r.direction *= -1;
      r.log_(`🔄 Sens inversé !`, 'effect');
      if (r.playerOrder.length === 2) r.nextTurn(true);
      else r.nextTurn();
    } else if (card.value === 'draw2') {
      r.drawPending += 2;
      r.nextTurn();
      const nextSid = r.currentSid();
      const nextP = r.players[nextSid];
      // Check if next can stack
      const canStack = nextP?.hand.some(c => c.value === 'draw2' || c.value === 'draw4');
      if (!canStack) {
        // Force draw
        for (let i = 0; i < r.drawPending; i++) r.drawCard(nextSid);
        r.log_(`💥 ${nextP?.username} pioche ${r.drawPending} cartes !`, 'effect');
        r.drawPending = 0;
        r.nextTurn();
      } else {
        r.log_(`💥 ${nextP?.username} doit jouer un +2/+4 ou piocher ${r.drawPending} !`, 'effect');
      }
    } else if (card.value === 'draw4') {
      r.drawPending += 4;
      r.nextTurn();
      const nextSid = r.currentSid();
      const nextP = r.players[nextSid];
      const canStack = nextP?.hand.some(c => c.value === 'draw4');
      if (!canStack) {
        for (let i = 0; i < r.drawPending; i++) r.drawCard(nextSid);
        r.log_(`💥 ${nextP?.username} pioche ${r.drawPending} cartes !`, 'effect');
        r.drawPending = 0;
        r.nextTurn();
      } else {
        r.log_(`💥 ${nextP?.username} doit jouer un +4 ou piocher ${r.drawPending} !`, 'effect');
      }
    } else {
      r.nextTurn();
    }

    const cur = r.players[r.currentSid()];
    if (r.phase === 'playing') r.log_(`🎯 Tour de ${cur?.username}`, 'turn');
    bcast(code);
  });

  socket.on('draw_card', ({ token, code }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r || r.phase !== 'playing') return;
    const sid = Object.keys(r.players).find(s => r.players[s].username === u.username);
    if (!sid || r.currentSid() !== sid) return socket.emit('err', 'Pas votre tour !');

    if (r.drawPending > 0) {
      for (let i = 0; i < r.drawPending; i++) r.drawCard(sid);
      r.log_(`💥 ${u.username} pioche ${r.drawPending} cartes !`, 'effect');
      r.drawPending = 0;
    } else {
      r.drawCard(sid);
      r.log_(`📥 ${u.username} pioche une carte`, 'draw');
    }
    r.nextTurn();
    const cur = r.players[r.currentSid()];
    r.log_(`🎯 Tour de ${cur?.username}`, 'turn');
    bcast(code);
  });

  socket.on('say_uno', ({ token, code }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r) return;
    const sid = Object.keys(r.players).find(s => r.players[s].username === u.username);
    if (!sid) return;
    const p = r.players[sid];
    if (p.hand.length === 1) {
      p.saidUno = true;
      r.log_(`🗣️ ${u.username} dit UNO !`, 'uno');
      bcast(code);
    }
  });

  socket.on('challenge_uno', ({ token, code, targetSid }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r) return;
    const target = r.players[targetSid];
    if (!target || target.hand.length !== 1 || target.saidUno) return;
    // Target forgot to say UNO - draw 2
    r.drawCard(targetSid); r.drawCard(targetSid);
    r.log_(`😱 ${target.username} a oublié de dire UNO ! +2 cartes !`, 'effect');
    bcast(code);
  });

  socket.on('chat', ({ token, code, msg }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r) return;
    const p = Object.values(r.players).find(p => p.username === u.username);
    if (!p) return;
    const clean = String(msg).trim().substring(0, 200);
    if (!clean) return;
    io.to(code).emit('chat_msg', { username: u.username, avatar: p.avatar, msg: clean });
  });

  socket.on('leave_room', ({ token, code }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r) return;
    const sid = Object.keys(r.players).find(s => r.players[s].username === u.username);
    if (sid) { r.del(sid); r.log_(`👋 ${u.username} a quitté`, 'system'); }
    if (!r.count()) delete rooms[code]; else bcast(code);
  });

  socket.on('restart_game', ({ token, code }) => {
    const u = auth(token); if (!u) return;
    const r = rooms[code]; if (!r || r.host !== u.username) return;
    Object.values(r.players).forEach(p => { p.hand = []; p.saidUno = false; });
    r.phase = 'lobby'; r.deck = []; r.discard = [];
    r.currentColor = null; r.winner = null; r.direction = 1;
    r.drawPending = 0; r.log = [];
    r.log_('🔄 Nouvelle partie !', 'system');
    bcast(code);
  });

  socket.on('disconnect', () => {
    const username = socketUsers[socket.id];
    if (username) {
      Object.entries(rooms).forEach(([code, r]) => {
        if (r.players[socket.id]) {
          r.players[socket.id].connected = false;
          r.log_(`📡 ${username} déconnecté`, 'system');
          bcast(code);
        }
      });
    }
    delete socketUsers[socket.id];
  });
});

function colorName(c) { return { red:'Rouge', green:'Vert', blue:'Bleu', yellow:'Jaune' }[c] || c; }
function colorEmoji(c) { return { red:'🔴', green:'🟢', blue:'🔵', yellow:'🟡', wild:'🌈' }[c] || '🎴'; }
function cardLabel(card) {
  if (card.value === 'skip') return 'Passe';
  if (card.value === 'reverse') return 'Inversion';
  if (card.value === 'draw2') return '+2';
  if (card.value === 'wild') return 'Joker';
  if (card.value === 'draw4') return '+4 Joker';
  return card.value;
}

server.listen(PORT, () => console.log(`🎴 UNO server on port ${PORT}`));
