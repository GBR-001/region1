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

// ─── PERSIST MULTIPLIER SETTINGS ──────────────────────────
const MULT_FILE = path.join(__dirname, 'multipliers.json');
function loadMultSettings() {
  try { return JSON.parse(fs.readFileSync(MULT_FILE, 'utf8')); } catch { return {}; }
}
function saveMultSettings() {
  try { fs.writeFileSync(MULT_FILE, JSON.stringify({
    periodic : state.periodicMultipliers,
    threshold: state.thresholdMultipliers,
  })); } catch(e) { console.error('[MULT] save error:', e.message); }
}
const _savedMult = loadMultSettings();

// ─── PERSIST COLORS, WINS & CONFIG ───────────────────────
const COLORS_FILE = path.join(__dirname, 'colors.json');
const WINS_FILE   = path.join(__dirname, 'wins.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch(e) { console.error('[SAVE]', e.message); }
}
const COLOR_PALETTE = [
  '#4f8ef7','#34d399','#fb923c','#a78bfa','#f5c542','#60a5fa',
  '#f87171','#2dd4bf','#e879f9','#84cc16','#f97316','#06b6d4',
  '#8b5cf6','#ec4899','#10b981','#f59e0b','#3b82f6','#ef4444',
  '#14b8a6','#6366f1',
];
const _loadedColors = loadJSON(COLORS_FILE, {});
const _loadedWins   = loadJSON(WINS_FILE,   {});
const _loadedCfg    = loadJSON(CONFIG_FILE, {});
// ───────────────────────────────────────────────────────────

// ─── GAME STATE ────────────────────────────────────────────
const state = {
  status              : 'idle',   // idle | active | paused | done
  regions             : ['იმერეთი','კახეთი','აჭარა','გურია','სვანეთი','სამეგრელო','ქართლი','ჰერეთი','რაჭა'],
  regionScores        : {},       // { 'იმერეთი': 340, ... }
  userScores          : {},       // { 'user123': 100, ... }
  userRegions         : {},       // { 'user123': 'იმერეთი', ... }
  donations           : [],       // last 20 for live feed
  userAvatars         : {},       // { 'user123': 'https://...' }
  aliases             : {},       // { 'იმერ': 'იმერეთი', ... }
  regionColors        : { ..._loadedColors },
  regionWins          : { ..._loadedWins },
  winsLabel           : _loadedCfg.winsLabel !== undefined ? _loadedCfg.winsLabel : '-ჯ. ჩემ.',
  rshPrefix           : 'RSH:',  // customizable region-change command
  duration            : 120,
  timeLeft            : 0,
  tiktokUsername      : '',
  mvp                 : null,     // { user, coins }
  tiktokConnected     : false,
  multiplier          : { active: false, value: 1, timeLeft: 0 },
  regionMultipliers   : {},
  periodicMultipliers : _savedMult.periodic  || [],
  thresholdMultipliers: _savedMult.threshold || [],
};
ensureColors(state.regions);

let timerInterval    = null;
let tiktokConnection = null;

// ─── HELPERS ───────────────────────────────────────────────
function initScores() {
  state.regionScores = {};
  state.userScores   = {};
  state.userRegions  = {};
  state.userAvatars  = {};
  state.donations    = [];
  state.mvp          = null;
  state.multiplier        = { active: false, value: 1, timeLeft: 0 };
  state.regionMultipliers = {};
  state.regions.forEach(r => (state.regionScores[r] = 0));
  Object.keys(pendingGifts).forEach(k => delete pendingGifts[k]);
}

function publicState() {
  const { userAvatars, ...rest } = state;
  return rest;
}

function updateMvp() {
  const top = Object.entries(state.userScores).sort((a, b) => b[1] - a[1])[0];
  state.mvp = top
    ? { user: top[0], coins: top[1], avatar: state.userAvatars[top[0]] || null }
    : null;
}

function broadcast() { io.emit('gameUpdate', publicState()); }

function ensureColors(regions) {
  const used = new Set(Object.values(state.regionColors));
  regions.forEach(r => {
    if (!state.regionColors[r]) {
      const avail = COLOR_PALETTE.filter(c => !used.has(c));
      const pool = avail.length ? avail : COLOR_PALETTE;
      const c = pool[Math.floor(Math.random() * pool.length)];
      state.regionColors[r] = c;
      used.add(c);
    }
  });
  saveJSON(COLORS_FILE, state.regionColors);
}

function recordWin() {
  const top = Object.entries(state.regionScores).sort((a, b) => b[1] - a[1]);
  if (!top.length || top[0][1] <= 0) return;
  const winner = top[0][0];
  state.regionWins[winner] = (state.regionWins[winner] || 0) + 1;
  saveJSON(WINS_FILE, state.regionWins);
  console.log(`[WIN] ${winner}  total: ${state.regionWins[winner]}`);
}

function activateMultiplier(value, duration) {
  state.multiplier = { active: true, value, timeLeft: duration };
  console.log(`[MULT-GLOBAL] x${value} for ${duration}s`);
}

function activateRegionMultiplier(region, value, duration) {
  state.regionMultipliers[region] = { value, timeLeft: duration };
  console.log(`[MULT-REGION] ${region} x${value} for ${duration}s`);
  broadcast();
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
  // Use mult stored at time of gift — not the current (possibly boosted) multiplier
  list.forEach(g => applyGift(username, g.coins, region, true, g.mult));
}

function applyGift(username, coins, region, silent = false, multOverride = null) {
  const globalMult = state.multiplier.active ? state.multiplier.value : 1;
  const regionMult = state.regionMultipliers[region] ? state.regionMultipliers[region].value : 1;
  const mult = multOverride !== null ? multOverride : Math.max(globalMult, regionMult);
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
// Threshold triggers a PER-REGION multiplier — only the sender's region gets boosted
function checkThreshold(perUnit, region) {
  console.log(`[THRESH] perUnit=${perUnit} region=${region} rules=${JSON.stringify(state.thresholdMultipliers)}`);
  if (!region) return;
  const matches = (state.thresholdMultipliers || []).filter(tm => perUnit >= tm.coins);
  if (matches.length === 0) { console.log(`[THRESH] no match (perUnit=${perUnit})`); return; }
  const best = matches.sort((a, b) => b.value - a.value)[0];
  const existing = state.regionMultipliers[region];
  if (!existing || best.value >= existing.value)
    activateRegionMultiplier(region, best.value, best.duration);
}

function onGift(username, coins, perUnit = coins) {
  if (state.status !== 'active') return;

  const region = state.userRegions[username];
  if (region) {
    // Apply first, then activate multiplier for NEXT gifts
    applyGift(username, coins, region);
    checkThreshold(perUnit, region);
    return;
  }
  // No region yet — buffer; store global mult at gift time
  const multAtGiftTime = state.multiplier.active ? state.multiplier.value : 1;
  if (!pendingGifts[username]) pendingGifts[username] = [];
  pendingGifts[username].push({ coins, ts: Date.now(), mult: multAtGiftTime });
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
function connectTikTok(username, sessionId, signingKey, ttIdc) {
  if (!username) return;
  if (tiktokConnection) { tiktokConnection.disconnect(); tiktokConnection = null; }

  io.emit('tiktokStatus', { connecting: true, username });

  const opts = {
    processInitialData      : false,
    enableExtendedGiftInfo  : true,
    requestPollingIntervalMs: 2000,
  };

  if (signingKey)             opts.signApiKey    = signingKey;
  if (sessionId && ttIdc)   { opts.sessionId     = sessionId; opts.ttTargetIdc = ttIdc; }
  else if (sessionId && !ttIdc) console.warn('[TIKTOK] sessionId provided but tt-target-idc missing — skipping session auth');

  console.log(`[TIKTOK] Connecting @${username}  signing=${!!signingKey}  session=${!!(sessionId&&ttIdc)}  idc=${ttIdc||'—'}`);

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
    const user = data.uniqueId || data.nickname;
    const av = data.profilePictureUrl || data.userDetails?.profilePictureUrl || null;
    if (av) state.userAvatars[user] = av;
    // For combo gifts (giftType=1): only process the FINAL event (repeatEnd===true).
    // Default to false (not done) so partial events with missing repeatEnd are skipped.
    if (data.giftType === 1) {
      const repeatEnd = data.repeatEnd ?? data.giftDetails?.repeatEnd ?? false;
      console.log(`[GIFT_RAW] combo user=${user} giftType=1 diamondCount=${data.diamondCount} repeatCount=${data.repeatCount} repeatEnd=${repeatEnd} giftName=${data.giftName}`);
      if (!repeatEnd) return;
    } else {
      console.log(`[GIFT_RAW] single user=${user} giftType=${data.giftType} diamondCount=${data.diamondCount} repeatCount=${data.repeatCount} giftName=${data.giftName}`);
    }
    const perUnit = data.diamondCount || 1;
    const coins   = perUnit * (data.repeatCount || 1);
    onGift(user, coins, perUnit);
  });

  tiktokConnection.on('chat', data => {
    const user = data.uniqueId || data.nickname;
    const av = data.profilePictureUrl || null;
    if (av) state.userAvatars[user] = av;
    onComment(user, data.comment || '');
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
  const ttIdc      = (req.body.ttIdc || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'username is required' });
  if (!isAllowed(raw)) {
    console.log(`[AUTH] Blocked: @${raw} not in users.json`);
    return res.status(403).json({ ok: false, error: `@${raw} არ არის დაშვებული. users.json-ში ჩაამატე.` });
  }

  state.tiktokUsername = raw;
  if (sessionId)  state.sessionId  = sessionId;
  if (signingKey) state.signingKey = signingKey;
  if (ttIdc)      state.ttIdc      = ttIdc;

  io.emit('tiktokStatus', { connecting: true, username: raw });
  connectTikTok(raw, sessionId || state.sessionId, signingKey || state.signingKey, ttIdc || state.ttIdc);
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
  ensureColors(state.regions);

  initScores();
  state.status   = 'active';
  state.timeLeft = state.duration;

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (state.status !== 'active') return;
    state.timeLeft--;

    // Tick global multiplier countdown
    if (state.multiplier.active) {
      state.multiplier.timeLeft--;
      if (state.multiplier.timeLeft <= 0)
        state.multiplier = { active: false, value: 1, timeLeft: 0 };
    }

    // Tick per-region multipliers
    Object.keys(state.regionMultipliers).forEach(r => {
      state.regionMultipliers[r].timeLeft--;
      if (state.regionMultipliers[r].timeLeft <= 0)
        delete state.regionMultipliers[r];
    });

    // Fire periodic multipliers at the configured second (global)
    (state.periodicMultipliers || []).forEach(pm => {
      if (state.timeLeft === pm.atSecond)
        activateMultiplier(pm.value, pm.duration);
    });

    if (state.timeLeft <= 0) {
      clearInterval(timerInterval);
      recordWin();
      state.status          = 'done';
      state.multiplier      = { active: false, value: 1, timeLeft: 0 };
      state.regionMultipliers = {};
      disconnectTikTok();
    }
    broadcast();
  }, 1000);

  // Don't reconnect if already connected — double connection causes double gift events
  if (!state.tiktokConnected)
    connectTikTok(state.tiktokUsername, state.sessionId, state.signingKey, state.ttIdc);
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
  if (state.status === 'active' || state.status === 'paused') recordWin();
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
  saveMultSettings();
  console.log('[MULT] settings saved — periodic:', state.periodicMultipliers.length, 'threshold:', state.thresholdMultipliers.length);
  console.log('[MULT] thresholds:', JSON.stringify(state.thresholdMultipliers));
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
  ensureColors(cleaned);
  broadcast();
  res.json({ ok: true });
});

// POST /api/set-colors { colors: { regionName: '#hex' } }
app.post('/api/set-colors', (req, res) => {
  const { colors } = req.body;
  if (typeof colors !== 'object' || Array.isArray(colors))
    return res.status(400).json({ error: 'colors must be an object' });
  Object.assign(state.regionColors, colors);
  saveJSON(COLORS_FILE, state.regionColors);
  broadcast();
  res.json({ ok: true });
});

// POST /api/set-wins { wins: { regionName: count } }
app.post('/api/set-wins', (req, res) => {
  const { wins } = req.body;
  if (typeof wins !== 'object' || Array.isArray(wins))
    return res.status(400).json({ error: 'wins must be an object' });
  Object.assign(state.regionWins, wins);
  saveJSON(WINS_FILE, state.regionWins);
  broadcast();
  res.json({ ok: true });
});

// POST /api/set-wins-label { label }
app.post('/api/set-wins-label', (req, res) => {
  if (typeof req.body.label !== 'string')
    return res.status(400).json({ error: 'label must be a string' });
  state.winsLabel = req.body.label;
  saveJSON(CONFIG_FILE, { winsLabel: state.winsLabel });
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
