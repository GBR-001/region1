// ============================================================
//  server.js  –  TikTok Region Battle
//  :3000        → main display (leaderboard only)
//  :3000/admin  → admin panel (full controls)
// ============================================================

const express                   = require('express');
const http                      = require('http');
const path                      = require('path');
const fs                        = require('fs');
const { Server }                = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ─── ALLOWED TIKTOK ACCOUNTS ───────────────────────────────
// Edit users.json to add/remove allowed TikTok usernames
function allowedUsers() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8')); }
  catch { return []; }
}
function isAllowed(username) {
  const list = allowedUsers();
  return list.map(u => u.toLowerCase()).includes(username.toLowerCase());
}
// ───────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ROUTES ────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── GAME STATE ────────────────────────────────────────────
const state = {
  status              : 'idle',   // idle | active | paused | done
  regions             : ['იმერეთი','კახეთი','აჭარა','გურია','სვანეთი','სამეგრელო','ქართლი','ჰერეთი','რაჭა'],
  regionScores        : {},       // { 'იმერეთი': 340, ... }
  userScores          : {},       // { 'user123': 100, ... }
  userRegions         : {},       // { 'user123': 'იმერეთი', ... }
  donations           : [],       // last 20 for live feed
  aliases             : {},       // { 'იმერ': 'იმერეთი', ... }
  rshPrefix           : 'RSH:',  // customizable region-change command
  duration            : 120,
  timeLeft            : 0,
  tiktokUsername      : '',
  mvp                 : null,     // { user, coins }
  tiktokConnected     : false,
  multiplier          : { active: false, value: 1, timeLeft: 0 },
  periodicMultipliers : [],   // [{ atSecond, value, duration }]
  thresholdMultipliers: [],   // [{ coins, value, duration }]
};

let timerInterval    = null;
let tiktokConnection = null;

// ─── HELPERS ───────────────────────────────────────────────
function initScores() {
  state.regionScores = {};
  state.userScores   = {};
  state.userRegions  = {};
  state.donations    = [];
  state.mvp          = null;
  state.multiplier   = { active: false, value: 1, timeLeft: 0 };
  state.regions.forEach(r => (state.regionScores[r] = 0));
  Object.keys(pendingGifts).forEach(k => delete pendingGifts[k]);
}

function publicState() { return { ...state }; }

function updateMvp() {
  const top = Object.entries(state.userScores).sort((a, b) => b[1] - a[1])[0];
  state.mvp = top ? { user: top[0], coins: top[1] } : null;
}

function broadcast() { io.emit('gameUpdate', publicState()); }

function activateMultiplier(value, duration) {
  state.multiplier = { active: true, value, timeLeft: duration };
  console.log(`[MULT] x${value} for ${duration}s`);
}

// ─── PENDING GIFTS BUFFER ──────────────────────────────────
// TikTok sends gift events BEFORE chat events.
// If a gift arrives before the user has commented a region,
// we hold it for the entire game and apply when the comment arrives.
const pendingGifts = {};   // { username: [{coins, ts}] }

function flushPending(username, region) {
  const list = pendingGifts[username];
  if (!list || list.length === 0) return;
  const total = list.reduce((s, g) => s + g.coins, 0);
  console.log(`[PENDING] ${username} → ${region}  flushing ${list.length} gifts (${total} coins)`);
  delete pendingGifts[username];
  list.forEach(g => applyGift(username, g.coins, region, true));
}

function applyGift(username, coins, region, silent = false) {
  const mult = state.multiplier.active ? state.multiplier.value : 1;
  const effective = coins * mult;
  state.regionScores[region] = (state.regionScores[region] || 0) + effective;
  state.userScores[username] = (state.userScores[username] || 0) + effective;
  updateMvp();
  state.donations.unshift({ username, coins: effective, region, time: new Date().toLocaleTimeString(), mult: mult > 1 ? mult : null });
  if (state.donations.length > 20) state.donations.pop();
  if (!silent) console.log(`[GIFT] ${username} → ${region} +${coins}${mult > 1 ? ` x${mult}=${effective}` : ''}`);
  broadcast();
}

// ─── REGION FINDER ─────────────────────────────────────────
// Checks exact region names first, then admin-defined aliases
function findRegion(text) {
  const exact = state.regions.find(r => text.includes(r));
  if (exact) return exact;
  for (const [word, region] of Object.entries(state.aliases)) {
    if (word && text.toLowerCase().includes(word.toLowerCase()) && state.regions.includes(region))
      return region;
  }
  return null;
}

// ─── CORE LOGIC ────────────────────────────────────────────

/**
 * GIFT event.
 * If the user already has a region → apply immediately.
 * If not → buffer the gift for up to PENDING_TTL ms.
 */
function onGift(username, coins) {
  if (state.status !== 'active') return;

  // Check threshold multipliers — activate the highest matching one
  const matches = (state.thresholdMultipliers || []).filter(tm => coins >= tm.coins);
  if (matches.length > 0) {
    const best = matches.sort((a, b) => b.value - a.value)[0];
    if (!state.multiplier.active || best.value >= state.multiplier.value)
      activateMultiplier(best.value, best.duration);
  }

  const region = state.userRegions[username];
  if (region) {
    applyGift(username, coins, region);
    return;
  }
  // No region yet — buffer until they comment a region
  if (!pendingGifts[username]) pendingGifts[username] = [];
  pendingGifts[username].push({ coins, ts: Date.now() });
  console.log(`[GIFT] ${username} (${coins}) – buffered, waiting for region comment`);
}

/**
 * COMMENT event.
 * 1. First-time: mentioning a region registers the user AND flushes buffered gifts.
 * 2. RSH: prefix changes an existing user's region.
 */
function onComment(username, comment) {
  if (state.status !== 'active') return;

  const RSH    = (state.rshPrefix || 'RSH:').toUpperCase();
  const hasRSH = comment.toUpperCase().includes(RSH);

  if (hasRSH) {
    const after     = comment.substring(comment.toUpperCase().indexOf(RSH) + RSH.length).trim();
    const newRegion = findRegion(after);
    if (newRegion) {
      const prev = state.userRegions[username];
      state.userRegions[username] = newRegion;
      console.log(`[CHANGE] ${username}: ${prev || '—'} → ${newRegion}`);
      flushPending(username, newRegion);
      broadcast();
    }
    return;
  }

  // Initial registration
  if (!state.userRegions[username]) {
    const mentioned = findRegion(comment);
    if (mentioned) {
      state.userRegions[username] = mentioned;
      console.log(`[JOIN] ${username} → ${mentioned}`);
      flushPending(username, mentioned);
      broadcast();
    }
  }
}

// ─── helpers ───────────────────────────────────────────────
// Safely extract a readable message from any thrown value
function errMsg(err) {
  if (!err)                        return 'Unknown error';
  if (typeof err === 'string')     return err;
  if (err.message)                 return err.message;
  if (err.code)                    return `Error code: ${err.code}`;
  try { return JSON.stringify(err); } catch (_) { return String(err); }
}

// ─── TIKTOK CONNECTION ─────────────────────────────────────
function connectTikTok(username, sessionId, signingKey) {
  if (!username) return;
  if (tiktokConnection) { tiktokConnection.disconnect(); tiktokConnection = null; }

  io.emit('tiktokStatus', { connecting: true, username });

  // v2.1.0: sessionId requires ttTargetIdc (account region cookie) — skip it for live reading
  const opts = {
    processInitialData      : false,
    enableExtendedGiftInfo  : true,
    requestPollingIntervalMs: 2000,
  };

  if (signingKey) opts.signApiKey = signingKey;

  console.log(`[TIKTOK] Connecting @${username}${sessionId ? ' +sessionId' : ''}${signingKey ? ' +signing' : ' (no signing — may not receive events)'}`);

  tiktokConnection = new WebcastPushConnection(username, opts);

  tiktokConnection.connect()
    .then(info => {
      console.log(`[TIKTOK] Connected @${username}  roomId=${info && info.roomId}`);
      state.tiktokConnected = true;
      io.emit('tiktokStatus', { connected: true, username });
      broadcast();
    })
    .catch(err => {
      const msg = errMsg(err);
      console.error('[TIKTOK] Connection failed:', msg);
      state.tiktokConnected = false;
      io.emit('tiktokStatus', { connected: false, error: msg });
    });

  tiktokConnection.on('gift', data => {
    const repeatEnd = data.repeatEnd ?? data.giftDetails?.repeatEnd ?? true;
    const user  = data.uniqueId || data.nickname;
    console.log(`[GIFT_RAW] user=${user} giftType=${data.giftType} diamondCount=${data.diamondCount} repeatCount=${data.repeatCount} repeatEnd=${repeatEnd} giftName=${data.giftName}`);
    if (data.giftType === 1 && !repeatEnd) return;
    const coins = (data.diamondCount || 1) * (data.repeatCount || 1);
    onGift(user, coins);
  });

  tiktokConnection.on('chat', data => {
    onComment(data.uniqueId || data.nickname, data.comment || '');
  });

  tiktokConnection.on('disconnected', () => {
    state.tiktokConnected = false;
    io.emit('tiktokStatus', { connected: false });
  });

  tiktokConnection.on('error', err => {
    const msg = errMsg(err);
    console.error('[TIKTOK] Error:', msg);

    // "Missing cursor" / "fetch" errors are polling hiccups — NOT fatal.
    // The roomId connection is alive; gifts and chat still arrive.
    const isFatal = !msg.toLowerCase().includes('cursor')
                 && !msg.toLowerCase().includes('fetch response')
                 && !msg.toLowerCase().includes('upgrade');

    if (isFatal) {
      state.tiktokConnected = false;
      io.emit('tiktokStatus', { connected: false, error: msg });
    } else {
      // Keep showing "connected" — just log a warning
      console.warn('[TIKTOK] Non-fatal polling warning (connection stays alive):', msg);
    }
  });
}

function disconnectTikTok() {
  if (tiktokConnection) { tiktokConnection.disconnect(); tiktokConnection = null; }
  state.tiktokConnected = false;
}

// ─── API ───────────────────────────────────────────────────

// POST /api/connect  { tiktokUsername, sessionId }
// Connects to TikTok LIVE independently (no need to start the game first)
app.post('/api/connect', (req, res) => {
  const raw        = (req.body.tiktokUsername || '').replace('@', '').trim();
  const sessionId  = (req.body.sessionId  || '').trim();
  const signingKey = (req.body.signingKey || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'username is required' });
  if (!isAllowed(raw)) {
    console.log(`[AUTH] Blocked: @${raw} not in users.json`);
    return res.status(403).json({ ok: false, error: `@${raw} არ არის დაშვებული. users.json-ში ჩაამატე.` });
  }

  state.tiktokUsername = raw;
  if (sessionId)  state.sessionId  = sessionId;
  if (signingKey) state.signingKey = signingKey;

  io.emit('tiktokStatus', { connecting: true, username: raw });
  connectTikTok(raw, sessionId || state.sessionId, signingKey || state.signingKey);
  res.json({ ok: true, username: raw });
});

// POST /api/disconnect
app.post('/api/disconnect', (req, res) => {
  disconnectTikTok();
  io.emit('tiktokStatus', { connected: false });
  broadcast();
  res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
  const { regions, duration, tiktokUsername } = req.body;
  if (Array.isArray(regions) && regions.length >= 2)
    state.regions = regions.map(r => r.trim()).filter(Boolean);
  if (duration)       state.duration       = Math.max(10, parseInt(duration));
  if (tiktokUsername) state.tiktokUsername = tiktokUsername.replace('@','').trim();

  initScores();
  state.status   = 'active';
  state.timeLeft = state.duration;

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (state.status !== 'active') return;
    state.timeLeft--;

    // Tick active multiplier countdown
    if (state.multiplier.active) {
      state.multiplier.timeLeft--;
      if (state.multiplier.timeLeft <= 0)
        state.multiplier = { active: false, value: 1, timeLeft: 0 };
    }

    // Fire periodic multipliers at the configured second
    (state.periodicMultipliers || []).forEach(pm => {
      if (state.timeLeft === pm.atSecond)
        activateMultiplier(pm.value, pm.duration);
    });

    if (state.timeLeft <= 0) {
      clearInterval(timerInterval);
      state.status   = 'done';
      state.multiplier = { active: false, value: 1, timeLeft: 0 };
      disconnectTikTok();
    }
    broadcast();
  }, 1000);

  connectTikTok(state.tiktokUsername, state.sessionId, state.signingKey);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/pause', (req, res) => {
  if (state.status === 'active')      state.status = 'paused';
  else if (state.status === 'paused') state.status = 'active';
  broadcast();
  res.json({ ok: true, status: state.status });
});

app.post('/api/stop', (req, res) => {
  if (timerInterval) clearInterval(timerInterval);
  state.status = 'done';
  disconnectTikTok();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  if (timerInterval) clearInterval(timerInterval);
  disconnectTikTok();
  initScores();
  state.status   = 'idle';
  state.timeLeft = 0;
  broadcast();
  res.json({ ok: true });
});

// POST /api/set-multipliers { periodic, threshold }
app.post('/api/set-multipliers', (req, res) => {
  const { periodic, threshold } = req.body;
  if (Array.isArray(periodic))   state.periodicMultipliers  = periodic;
  if (Array.isArray(threshold))  state.thresholdMultipliers = threshold;
  broadcast();
  res.json({ ok: true });
});

// POST /api/update-regions { regions }
app.post('/api/update-regions', (req, res) => {
  const { regions } = req.body;
  if (!Array.isArray(regions) || regions.length < 2)
    return res.status(400).json({ error: 'minimum 2 regions required' });
  const cleaned = regions.map(r => r.trim()).filter(Boolean);
  cleaned.forEach(r => { if (!state.regionScores[r]) state.regionScores[r] = 0; });
  state.regions = cleaned;
  broadcast();
  res.json({ ok: true });
});

// POST /api/aliases  { aliases: { word: region } }
app.post('/api/aliases', (req, res) => {
  const { aliases } = req.body;
  if (typeof aliases !== 'object' || Array.isArray(aliases))
    return res.status(400).json({ error: 'aliases must be an object' });
  state.aliases = aliases;
  res.json({ ok: true });
});

// POST /api/transfer  { username, toRegion }
app.post('/api/transfer', (req, res) => {
  const { username, toRegion } = req.body;
  if (!username || !toRegion) return res.status(400).json({ error: 'username and toRegion required' });
  if (!state.regions.includes(toRegion)) return res.status(400).json({ error: 'invalid region' });
  const fromRegion = state.userRegions[username];
  if (!fromRegion) return res.status(400).json({ error: 'user not found or has no region' });
  if (fromRegion === toRegion) return res.json({ ok: true, message: 'already in that region' });
  const score = state.userScores[username] || 0;
  state.regionScores[fromRegion] = Math.max(0, (state.regionScores[fromRegion] || 0) - score);
  state.regionScores[toRegion]   = (state.regionScores[toRegion] || 0) + score;
  state.userRegions[username] = toRegion;
  console.log(`[TRANSFER] ${username}: ${fromRegion} → ${toRegion} (${score} coins)`);
  broadcast();
  res.json({ ok: true, username, fromRegion, toRegion, coins: score });
});

// Simulation (for testing without a real live stream)
app.post('/api/simulate', (req, res) => {
  const { username, coins, comment } = req.body;
  if (!username || !coins) return res.status(400).json({ error: 'username and coins required' });
  if (comment) onComment(username, comment);
  onGift(username, parseInt(coins));
  res.json({ ok: true });
});

// POST /api/set-prefix { prefix }
app.post('/api/set-prefix', (req, res) => {
  const p = (req.body.prefix || '').trim();
  if (!p) return res.status(400).json({ error: 'prefix required' });
  state.rshPrefix = p;
  res.json({ ok: true, prefix: p });
});

app.get('/api/state', (req, res) => res.json(publicState()));

// ─── SOCKET.IO ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[WS] +client (${io.engine.clientsCount} total)`);
  socket.emit('gameUpdate', publicState());
});

// ─── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮  Display  →  http://localhost:${PORT}`);
  console.log(`⚙️   Admin   →  http://localhost:${PORT}/admin\n`);
});
