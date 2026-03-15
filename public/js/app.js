// ─── MUSIC ───────────────────────────────────────────────────
const TRACKS = {
  lobby: 'https://cdn.pixabay.com/audio/2023/04/10/audio_9f5ae47858.mp3',
  game:  'https://cdn.pixabay.com/audio/2022/03/15/audio_8cb749c761.mp3',
};
let audio = null, curTrack = null, musicOn = true, musicStarted = false;
function playMusic(t) {
  if (!musicOn) return;
  if (curTrack === t && audio && !audio.paused) return;
  if (audio) { audio.pause(); audio.currentTime = 0; }
  curTrack = t;
  if (!TRACKS[t]) return;
  audio = new Audio(TRACKS[t]); audio.loop = true; audio.volume = 0.2;
  audio.play().catch(() => {});
}
function toggleMusic() {
  musicOn = !musicOn;
  const b = document.getElementById('music-btn');
  if (!musicOn) { if (audio) audio.pause(); if (b) b.textContent = '🔇'; }
  else { if (b) b.textContent = '🔊'; playMusic(curTrack || 'lobby'); }
}
function startMusicOnce() {
  if (musicStarted) return; musicStarted = true;
  playMusic('lobby');
  document.removeEventListener('click', startMusicOnce);
  document.removeEventListener('keydown', startMusicOnce);
}
document.addEventListener('click', startMusicOnce);
document.addEventListener('keydown', startMusicOnce);

// ─── DATA ────────────────────────────────────────────────────
const ALL_AVATARS = ['🎴','🃏','🎲','🎯','🎪','🎨','🎭','🎬','🎮','🕹️','🎸','🎺','🎻','🥁','🎹','🌈','⭐','🔥','💎','👑','🦊','🐺','🐉','🦋','🌙','⚡','🍀','🎃','👾','🤖'];

const COLOR_BG = { red:'#e53e3e', green:'#2ecc40', blue:'#0084ff', yellow:'#ffd700', wild:'linear-gradient(135deg,#e53e3e,#ffd700,#2ecc40,#0084ff)' };
const COLOR_NAME = { red:'Rouge 🔴', green:'Vert 🟢', blue:'Bleu 🔵', yellow:'Jaune 🟡' };

function cardLabel(card) {
  if (!card) return '';
  if (card.value === 'skip') return '⏭';
  if (card.value === 'reverse') return '🔄';
  if (card.value === 'draw2') return '+2';
  if (card.value === 'wild') return '🌈';
  if (card.value === 'draw4') return '+4';
  return card.value;
}

// ─── STATE ───────────────────────────────────────────────────
let token = localStorage.getItem('uno_token');
let myUsername = localStorage.getItem('uno_user') || '';
let myAvatar = localStorage.getItem('uno_avatar') || '🎴';
let currentRoom = null, gs = null;
let socket = null, mySid = null;
let selectedAv = '🎴';
let pendingCard = null; // card waiting for color choice
let endShown = false;

// ─── INIT ─────────────────────────────────────────────────────
function init() {
  buildAvPicker();
  socket = io();
  socket.on('connect', () => { mySid = socket.id; if (token) socket.emit('auth', { token }); });
  socket.on('auth_ok', ({ username, avatar }) => {
    myUsername = username; myAvatar = avatar || '🎴';
    localStorage.setItem('uno_user', username); localStorage.setItem('uno_avatar', myAvatar);
    document.getElementById('my-name').textContent = username;
    document.getElementById('my-avatar').textContent = myAvatar;
    show('s-menu');
  });
  socket.on('auth_error', () => { token = null; localStorage.clear(); show('s-auth'); });
  socket.on('err', msg => showErr(msg));
  socket.on('room_joined', ({ code }) => {
    currentRoom = code;
    document.getElementById('room-code').textContent = code;
    show('s-room'); playMusic('lobby');
  });
  socket.on('state', st => onState(st));
  socket.on('chat_msg', m => appendChat(m));

  if (token) socket.emit('auth', { token });
  else show('s-auth');

  document.getElementById('chat-in').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  const rci = document.getElementById('room-chat-in');
  if (rci) rci.addEventListener('keydown', e => { if (e.key === 'Enter') sendRoomChat(); });
}

function buildAvPicker() {
  const g = document.getElementById('avatar-grid'); if (!g) return;
  g.innerHTML = ALL_AVATARS.map(a => `<span class="av-opt${a===selectedAv?' sel':''}" onclick="pickAv('${a}')">${a}</span>`).join('');
}
function pickAv(a) {
  selectedAv = a;
  document.getElementById('avatar-preview').textContent = a;
  document.querySelectorAll('.av-opt').forEach(el => el.classList.toggle('sel', el.textContent === a));
}

// ─── AUTH ──────────────────────────────────────────────────────
async function login() {
  const u = document.getElementById('l-user').value.trim();
  const p = document.getElementById('l-pass').value;
  if (!u || !p) return setErr('auth-err', 'Remplis tous les champs');
  try {
    const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:u,password:p}) });
    const d = await r.json();
    if (!r.ok) return setErr('auth-err', d.error);
    saveAuth(d);
  } catch { setErr('auth-err', 'Erreur réseau'); }
}
async function register() {
  const u = document.getElementById('r-user').value.trim();
  const p = document.getElementById('r-pass').value;
  if (!u || !p) return setErr('auth-err', 'Remplis tous les champs');
  try {
    const r = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:u,password:p,avatar:selectedAv}) });
    const d = await r.json();
    if (!r.ok) return setErr('auth-err', d.error);
    saveAuth(d);
  } catch { setErr('auth-err', 'Erreur réseau'); }
}
function saveAuth({ token: t, username, avatar }) {
  token = t; myUsername = username; myAvatar = avatar || '🎴';
  localStorage.setItem('uno_token', t);
  localStorage.setItem('uno_user', username);
  localStorage.setItem('uno_avatar', myAvatar);
  if (socket) socket.emit('auth', { token });
  document.getElementById('my-name').textContent = username;
  document.getElementById('my-avatar').textContent = myAvatar;
  show('s-menu');
}
function logout() { token = null; localStorage.clear(); show('s-auth'); }
function switchTab(t) {
  document.querySelectorAll('.tab').forEach((b,i) => b.classList.toggle('active',(i===0&&t==='login')||(i===1&&t==='register')));
  document.getElementById('t-login').classList.toggle('active', t==='login');
  document.getElementById('t-register').classList.toggle('active', t==='register');
  setErr('auth-err', '');
}

// ─── ROOM ──────────────────────────────────────────────────────
function createRoom() { socket.emit('create_room', { token }); }
function toggleJoin() { document.getElementById('join-box').classList.toggle('hidden'); }
function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) return;
  socket.emit('join_room', { token, code });
}
function leaveRoom() { socket.emit('leave_room', { token, code: currentRoom }); currentRoom = null; show('s-menu'); playMusic('lobby'); }
function copyCode() { navigator.clipboard?.writeText(currentRoom); const b=document.querySelector('.copy-btn'); b.textContent='✅'; setTimeout(()=>b.textContent='📋',1400); }
function startGame() { socket.emit('start_game', { token, code: currentRoom }); }
function sendRoomChat() {
  const el = document.getElementById('room-chat-in');
  const msg = el?.value.trim(); if (!msg || !currentRoom) return;
  socket.emit('chat', { token, code: currentRoom, msg }); el.value = '';
}

// ─── STATE ─────────────────────────────────────────────────────
function onState(st) {
  gs = st;
  mySid = mySid || socket.id;
  const sid = gs.players[mySid] ? mySid : Object.keys(gs.players).find(k => gs.players[k].username === myUsername);

  if (st.phase === 'lobby') { show('s-room'); renderRoom(st, sid); return; }
  show('s-game'); playMusic('game'); renderGame(st, sid);

  if (st.phase === 'finished' && !endShown) {
    endShown = true;
    const isWin = st.winner === myUsername;
    showEnd(isWin ? '🏆 VICTOIRE !' : '😢 Défaite...', isWin ? `Tu as gagné ! Bravo champion ! 🎉` : `${st.winner} a gagné cette partie.`, isWin ? '🏆' : '🃏', gs.players[sid]?.isHost);
  }
  if (st.phase !== 'finished') endShown = false;
}

function renderRoom(st, sid) {
  const { players, playerOrder } = st;
  const allPlayers = playerOrder?.length ? playerOrder.map(s => [s, players[s]]).filter(([,p])=>p) : Object.entries(players);
  document.getElementById('players-wrap').innerHTML = allPlayers.map(([,p]) =>
    `<div class="p-card ${p.isHost?'host':''}">
      <span class="p-av">${p.avatar||'🎴'}</span>
      <div class="p-nm">${p.username}</div>
      ${p.isHost?'<span class="p-badge">HÔTE</span>':''}
    </div>`).join('');
  const cnt = Object.keys(players).length;
  document.getElementById('player-count').textContent = `${cnt}/8 joueurs`;
  const isHost = players[sid]?.isHost;
  const btn = document.getElementById('start-btn');
  btn.style.display = isHost ? 'block' : 'none';
  btn.textContent = cnt < 2 ? `🔒 Minimum 2 joueurs (${cnt}/2)` : '🎴 Lancer la partie !';
  btn.disabled = cnt < 2;
}

function renderGame(st, sid) {
  const { players, playerOrder, topCard, currentColor, currentPlayer, direction, drawPending, deckCount, myHand, log } = st;
  const me = players[sid];
  const isMyTurn = currentPlayer === sid;

  // Header info
  document.getElementById('g-direction').textContent = direction === 1 ? '↻ Sens normal' : '↺ Sens inversé';
  const ci = document.getElementById('g-color-indicator');
  ci.innerHTML = currentColor ? `<span style="display:inline-flex;align-items:center;gap:.3rem"><span style="width:18px;height:18px;border-radius:50%;background:${COLOR_BG[currentColor] || '#888'};display:inline-block;border:2px solid rgba(255,255,255,.5)"></span>${COLOR_NAME[currentColor]||currentColor}</span>` : '';

  const dp = document.getElementById('g-draw-pending');
  if (drawPending > 0) { dp.style.display='inline'; dp.textContent = `⚠️ +${drawPending} à piocher !`; dp.style.color='#ff6b6b'; }
  else dp.style.display = 'none';

  // Turn indicator
  const ti = document.getElementById('turn-indicator');
  if (isMyTurn) { ti.textContent = '🎯 C\'est TON TOUR !'; ti.style.color='#ffd700'; ti.style.animation='unoPulse 1s infinite'; }
  else { const cur = players[currentPlayer]; ti.textContent = `⏳ Tour de ${cur?.username||'?'}`; ti.style.color='rgba(255,255,255,.7)'; ti.style.animation='none'; }

  // Deck & Discard
  document.getElementById('deck-count').textContent = `${deckCount} cartes`;
  const dp2 = document.getElementById('discard-pile');
  if (topCard) {
    dp2.style.background = topCard.color === 'wild' ? COLOR_BG.wild : (COLOR_BG[currentColor] || COLOR_BG[topCard.color]);
    dp2.innerHTML = `<span style="font-family:'Fredoka One';font-size:1.6rem;color:${topCard.color==='yellow'?'#1a1a1a':'#fff'};text-shadow:0 2px 4px rgba(0,0,0,.5)">${cardLabel(topCard)}</span>`;
  }

  // Other players
  const op = document.getElementById('other-players');
  const others = playerOrder.filter(s => s !== sid);
  op.innerHTML = others.map(s => {
    const p = players[s];
    if (!p) return '';
    const isCur = s === currentPlayer;
    return `<div class="opp-card ${isCur?'current-turn':''}">
      ${p.saidUno&&p.handCount===1?'<div class="opp-uno">UNO!</div>':''}
      <div class="opp-av">${p.avatar||'🎴'}</div>
      <div class="opp-nm">${p.username}</div>
      <div class="opp-cards">🃏 ${p.handCount} carte${p.handCount!==1?'s':''}</div>
      ${p.handCount===1&&!p.saidUno?`<button class="challenge-btn" onclick="challengeUno('${s}')">⚠️ UNO raté !</button>`:''}
    </div>`;
  }).join('');

  // My hand
  document.getElementById('hand-count').textContent = myHand?.length || 0;
  const handEl = document.getElementById('my-hand');
  if (myHand && myHand.length > 0) {
    const topC = topCard;
    handEl.innerHTML = myHand.map((card, i) => {
      const playable = isMyTurn && canPlayCard(card, topC, currentColor, drawPending);
      return `<div class="uno-card ${card.color} ${playable?'playable':'not-playable'}" onclick="${playable?`playCard(${i})`:''}" title="${playable?'Jouable':'Non jouable'}">
        <span class="cs">${cardLabel(card)}</span>
        <span class="cv">${cardLabel(card)}</span>
      </div>`;
    }).join('');
  } else {
    handEl.innerHTML = '<p style="color:var(--muted);font-size:.8rem;text-align:center">Aucune carte</p>';
  }

  // Log
  const ll = document.getElementById('log-list');
  ll.innerHTML = log.map(e => `<div class="log-entry ${e.type}">${e.msg}</div>`).join('');
  ll.scrollTop = ll.scrollHeight;
}

function canPlayCard(card, topCard, currentColor, drawPending) {
  if (!topCard) return true;
  if (drawPending > 0) return card.value === 'draw2' || card.value === 'draw4';
  if (card.type === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

// ─── GAME ACTIONS ──────────────────────────────────────────────
function playCard(cardIdx) {
  if (!gs) return;
  const card = gs.myHand?.[cardIdx];
  if (!card) return;
  if (card.type === 'wild') {
    pendingCard = cardIdx;
    document.getElementById('color-picker').classList.remove('hidden');
  } else {
    socket.emit('play_card', { token, code: currentRoom, cardIdx });
  }
}

function chooseColor(color) {
  document.getElementById('color-picker').classList.add('hidden');
  if (pendingCard !== null) {
    socket.emit('play_card', { token, code: currentRoom, cardIdx: pendingCard, chosenColor: color });
    pendingCard = null;
  }
}

function drawCard() {
  if (!gs) return;
  const sid = gs.players[mySid] ? mySid : Object.keys(gs.players).find(k => gs.players[k].username === myUsername);
  if (gs.currentPlayer !== sid) return;
  socket.emit('draw_card', { token, code: currentRoom });
}

function sayUno() { socket.emit('say_uno', { token, code: currentRoom }); }
function challengeUno(targetSid) { socket.emit('challenge_uno', { token, code: currentRoom, targetSid }); }

// ─── CHAT ──────────────────────────────────────────────────────
function sendChat() {
  const el = document.getElementById('chat-in');
  const msg = el.value.trim(); if (!msg || !currentRoom) return;
  socket.emit('chat', { token, code: currentRoom, msg }); el.value = '';
}
function appendChat({ username, avatar, msg }) {
  ['chat-msgs','room-chat-msgs'].forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    const d = document.createElement('div'); d.className = 'c-msg';
    d.innerHTML = `<span class="c-nm">${avatar||'🎴'} ${username}</span><span style="font-size:.78rem">${esc(msg)}</span>`;
    c.appendChild(d); c.scrollTop = c.scrollHeight;
  });
}

// ─── END ───────────────────────────────────────────────────────
function showEnd(title, body, ico, isHost) {
  document.getElementById('end-ico').textContent = ico;
  document.getElementById('end-title').textContent = title;
  document.getElementById('end-body').textContent = body;
  document.getElementById('btn-replay').style.display = isHost ? 'block' : 'none';
  document.getElementById('end-overlay').classList.remove('hidden');
}
function endGoMenu() {
  socket.emit('leave_room', { token, code: currentRoom });
  currentRoom = null;
  document.getElementById('end-overlay').classList.add('hidden');
  show('s-menu'); playMusic('lobby');
}
function endReplay() {
  socket.emit('restart_game', { token, code: currentRoom });
  document.getElementById('end-overlay').classList.add('hidden');
  endShown = false;
}

// ─── NOTIF ─────────────────────────────────────────────────────
function showNotif(title, body, ico='🎴') {
  document.getElementById('notif-ico').textContent = ico;
  document.getElementById('notif-title').textContent = title;
  document.getElementById('notif-body').textContent = body;
  document.getElementById('notif-overlay').classList.remove('hidden');
}
function closeNotif() { document.getElementById('notif-overlay').classList.add('hidden'); }

// ─── UTILS ─────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id); if (el) el.classList.add('active');
}
function setErr(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; if (msg) setTimeout(()=>el.textContent='',4000); }
}
function showErr(msg) {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const e = active.querySelector('.err');
  if (e) { e.textContent = msg; setTimeout(()=>e.textContent='',4000); }
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

init();
