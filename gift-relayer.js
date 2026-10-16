'use strict';
// ============================================================================
//  VoidGifts GAME SERVER
//
//  The app (script.js) no longer decides anything. It only asks this server:
//    "spin the Furry wheel x10", "open my daily gift", "redeem promocode X",
//    "convert prize Y to coins" ...
//  and shows what comes back. Odds, prices, balances, cooldowns and promocodes
//  all live HERE, so nothing can be changed from the browser console (F12).
//
//  Every /api request carries Telegram's signed initData (X-Telegram-Init-Data).
//  The user id is taken from that signature — never from the request body — so
//  one player can't act as another.
//
//  Shares the same Postgres as prize-store (users + prizes tables).
//
//  ENV (Railway variables)
//    DATABASE_URL            same Postgres as prize-store                    (required)
//    BOT_TOKEN               the mini-app bot's token (verifies initData)    (required)
//    ADMIN_API_KEY           protects /admin/* and /admin/panel              (required for admin)
//    BOT_URL                 main bot service (VGServers) base URL. Used to collect
//                            Telegram-Stars purchases and to check channel subscription
//    TON_API_URL             TON payments service base URL (collects TON purchases)
//    ENFORCE_SUBSCRIPTION    "true" (default when BOT_URL is set) | "false"
//    ALLOWED_ORIGINS         comma-separated origins allowed by CORS (default: *)
//    INITDATA_MAX_AGE_SECONDS  how old a signed session may be (default 604800 = 7 days)
//    (promocode access rule: promoAccess in game-config.js — default: pay 2 TON, or be allowed by hand)
//    RATE_MULT               optional, multiplies all per-user rate limits (default 1)
//    PORT                    default 3003
// ============================================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const CFG = require('./game-config');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const BOT_URL = (process.env.BOT_URL || '').replace(/\/$/, '');
const TON_API_URL = (process.env.TON_API_URL || '').replace(/\/$/, '');
const ENFORCE_SUB = process.env.ENFORCE_SUBSCRIPTION ? process.env.ENFORCE_SUBSCRIPTION === 'true' : !!BOT_URL;
const MAX_AGE = parseInt(process.env.INITDATA_MAX_AGE_SECONDS, 10) || 7 * 24 * 3600;
const PORT = process.env.PORT || 3003;

// ---------------------------------------------------------------------------
// Config validation — the server refuses to start with a broken table.
// ---------------------------------------------------------------------------
function validateConfig() {
  const errs = [];
  if (!Array.isArray(CFG.multipliers) || !CFG.multipliers.includes(1)) errs.push('multipliers must be an array that includes 1');
  for (const [name, w] of Object.entries(CFG.wheels)) {
    const sum = (t) => t.reduce((a, r) => a + r.chance, 0);
    if (Math.abs(sum(w.prizes) - 100) > 0.001) errs.push(`${name}: prizes total ${sum(w.prizes).toFixed(4)} (must be 100)`);
    if (Math.abs(sum(w.preview) - 100) > 0.001) errs.push(`${name}: preview total ${sum(w.preview).toFixed(4)} (must be 100)`);
    const a = w.prizes.map((r) => r.id).sort().join('|');
    const b = w.preview.map((r) => r.id).sort().join('|');
    if (a !== b) errs.push(`${name}: preview ids differ from prizes ids`);
    const seen = new Set();
    for (const r of w.prizes) {
      if (seen.has(r.id)) errs.push(`${name}: duplicate id ${r.id}`);
      seen.add(r.id);
      if (!(r.chance > 0)) errs.push(`${name}: ${r.id} chance must be > 0`);
      if (!['coin', 'stars', 'gift'].includes(r.type)) errs.push(`${name}: ${r.id} bad type ${r.type}`);
      if (r.type === 'gift' && !(r.value in CFG.coinValues)) errs.push(`${name}: gift "${r.value}" has no coinValues entry`);
      if (r.type !== 'gift' && !(Number(r.value) > 0)) errs.push(`${name}: ${r.id} value must be > 0`);
    }
    if (!(w.price >= 0)) errs.push(`${name}: bad price`);
  }
  if (errs.length) {
    console.error('❌ game-config.js is invalid:\n  - ' + errs.join('\n  - '));
    process.exit(1);
  }
}
validateConfig();

if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL is required'); process.exit(1); }
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : undefined });

const GIFT_NAMES = new Set(Object.keys(CFG.coinValues));
const NFT_SET = new Set(CFG.nftGifts);
const DAILY_MS = Math.round((CFG.dailyCooldownHours || 24) * 3600 * 1000);

// ---------------------------------------------------------------------------
// Telegram initData verification (same algorithm the bot and relayer use)
// ---------------------------------------------------------------------------
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (computed.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash))) return null;
  const authDate = parseInt(params.get('auth_date'), 10) || 0;
  if (Date.now() / 1000 - authDate > MAX_AGE) return null;
  try {
    const u = JSON.parse(params.get('user') || 'null');
    return u && Number.isSafeInteger(u.id) && u.id > 0 ? u : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// App + tiny rate limiter
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: origins.includes('*') ? true : origins,
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'X-Admin-Key'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '20kb' }));

const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > windowMs) b = { t: now, n: 0 };
  b.n++; buckets.set(key, b);
  return b.n <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 120000) buckets.delete(k); }, 60000).unref();
const RATE_MULT = Number(process.env.RATE_MULT) || 1;   // raise to loosen every per-user limit (e.g. 2 = double)
const limit = (name, n, ms) => (req, res, next) =>
  hit(`${name}:${req.user ? req.user.id : req.ip}`, n * RATE_MULT, ms) ? next() : res.status(429).json({ error: 'Too many requests, slow down', code: 'RATE_LIMITED' });

function auth(req, res, next) {
  const user = verifyInitData(req.get('x-telegram-init-data'));
  if (!user) return res.status(401).json({ error: 'Invalid or expired Telegram session', code: 'UNAUTHORIZED' });
  req.user = user;
  next();
}
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err && err.http) return res.status(err.http).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  console.error(`❌ ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
});
const fail = (http, code, message, extra) => Object.assign(new Error(message), { http, code, extra });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prizes (
      prize_id TEXT PRIMARY KEY, gift_name TEXT NOT NULL, user_id BIGINT NOT NULL, username TEXT,
      status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), error_message TEXT, claim_type TEXT,
      scheduled_for TIMESTAMPTZ, nft_slug TEXT);
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, avatar_url TEXT,
      coins BIGINT NOT NULL DEFAULT 0, stars BIGINT NOT NULL DEFAULT 0, stars_spent BIGINT NOT NULL DEFAULT 0,
      show_in_leaderboard BOOLEAN NOT NULL DEFAULT true, last_claim_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stars_spent BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_last_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_allowed BOOLEAN;          -- NULL = automatic rule, true = always allowed, false = blocked
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ton_paid NUMERIC(18,4) NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_prizes_user_id ON prizes (user_id);

    CREATE TABLE IF NOT EXISTS promocodes (
      code        TEXT PRIMARY KEY,
      active      BOOLEAN     NOT NULL DEFAULT true,
      starts_at   TIMESTAMPTZ,
      expires_at  TIMESTAMPTZ,
      max_uses    INTEGER,
      uses        INTEGER     NOT NULL DEFAULT 0,
      coins       BIGINT      NOT NULL DEFAULT 0,
      stars       BIGINT      NOT NULL DEFAULT 0,
      gifts       JSONB       NOT NULL DEFAULT '[]'::jsonb,
      message_key TEXT,
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      code TEXT NOT NULL, user_id BIGINT NOT NULL, redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (code, user_id));
    CREATE TABLE IF NOT EXISTS ledger (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, kind TEXT NOT NULL,
      stars BIGINT NOT NULL DEFAULT 0, coins BIGINT NOT NULL DEFAULT 0,
      ref TEXT UNIQUE, meta JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (user_id, id DESC);
  `);
  await pool.query('ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS open_to_all BOOLEAN NOT NULL DEFAULT false');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM promocodes');
  if (rows[0].n === 0) {
    for (const p of CFG.SEED_PROMOS || []) {
      await pool.query(
        `INSERT INTO promocodes (code, active, coins, stars, gifts, message_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [p.code.toUpperCase(), p.active !== false, p.rewards?.coins || 0, p.rewards?.stars || 0, JSON.stringify(p.rewards?.gifts || []), p.message_key || null]);
    }
    console.log('🌱 Seeded promocodes from game-config.js');
  }
  console.log('✅ Game tables ready');
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// Make sure the row exists, refresh the public profile, and lock it for the transaction.
async function lockUser(c, tgUser) {
  await c.query(
    `INSERT INTO users (user_id, username, first_name, last_name, avatar_url)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET
       username = COALESCE($2, users.username), first_name = COALESCE($3, users.first_name),
       last_name = COALESCE($4, users.last_name), avatar_url = COALESCE($5, users.avatar_url)`,
    [tgUser.id, tgUser.username ?? null, tgUser.first_name ?? null, tgUser.last_name ?? null, tgUser.photo_url ?? null]);
  const r = await c.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [tgUser.id]);
  return r.rows[0];
}

const bal = (u) => ({ stars: Number(u.stars), coins: Number(u.coins), stars_spent: Number(u.stars_spent) });

// Who may redeem promocodes (anti alt-account / bot farming). See promoAccess in game-config.js.
//   promo_allowed = true   -> always allowed (manual switch, /admin/panel)
//   promo_allowed = false  -> blocked
//   NULL                   -> allowed once the account has paid >= minTonPaid TON in total
function promoAccess(u) {
  const A = CFG.promoAccess || {};
  const need = Number(A.minTonPaid ?? 2);
  const paid = Math.round(Number(u.ton_paid || 0) * 10000) / 10000;
  const base = { required_ton: need, paid_ton: paid };
  if (u.promo_allowed === false) return { allowed: false, reason: 'blocked', ...base };
  if (u.promo_allowed === true)  return { allowed: true,  reason: 'manual', ...base };
  if (A.requirePayment === false) return { allowed: true, reason: 'open', ...base };
  return paid >= need ? { allowed: true, reason: 'paid', ...base } : { allowed: false, reason: 'payment_required', ...base };
}

// ---------------------------------------------------------------------------
// Rolling & prize creation
// ---------------------------------------------------------------------------
function rollOne(prizes) {
  const r = crypto.randomInt(0, 1_000_000_000) / 1e7;       // uniform in [0, 100)
  let cum = 0;
  for (const p of prizes) { cum += p.chance; if (r < cum) return p; }
  return prizes[prizes.length - 1];
}

function newPrizeId() {
  const four = crypto.randomInt(1000, 10000), two = crypto.randomInt(10, 100);
  let three = '';
  for (let i = 0; i < 3; i++) three += String.fromCharCode(65 + crypto.randomInt(0, 26));
  return `${four}-${two}-${three}`;
}

async function createGift(c, tgUser, giftName) {
  for (let i = 0; i < 8; i++) {
    const id = newPrizeId();
    const r = await c.query(
      `INSERT INTO prizes (prize_id, gift_name, user_id, username, status) VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (prize_id) DO NOTHING RETURNING prize_id`,
      [id, giftName, tgUser.id, tgUser.username ?? null]);
    if (r.rowCount) return id;
  }
  throw new Error('could not allocate a prize id');
}

// Applies a list of prize objects to the user. Returns result rows for the app.
async function grantPrizes(c, tgUser, list) {
  let stars = 0, coins = 0;
  const results = [];
  for (const p of list) {
    if (p.type === 'stars') { stars += Number(p.value); results.push({ id: p.id, type: 'stars', value: Number(p.value) }); }
    else if (p.type === 'coin') { coins += Number(p.value); results.push({ id: p.id, type: 'coin', value: Number(p.value) }); }
    else { results.push({ id: p.id, type: 'gift', value: p.value, prize_id: await createGift(c, tgUser, p.value) }); }
  }
  return { stars, coins, results };
}

const addLedger = (c, userId, kind, stars, coins, meta, ref) =>
  c.query('INSERT INTO ledger (user_id, kind, stars, coins, meta, ref) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ref) DO NOTHING',
    [userId, kind, stars, coins, meta ? JSON.stringify(meta) : null, ref || null]);

// ---------------------------------------------------------------------------
// Subscription gate (asks the main bot, which also honours manual overrides)
// ---------------------------------------------------------------------------
const subCache = new Map();
async function requireSubscription(userId) {
  if (!ENFORCE_SUB) return;
  const hitc = subCache.get(userId);
  if (hitc && Date.now() - hitc < 120000) return;
  let data;
  try {
    const r = await fetch(`${BOT_URL}/check-subscription?user_id=${userId}`, { signal: AbortSignal.timeout(7000) });
    data = await r.json();
  } catch {
    throw fail(503, 'SUBSCRIPTION_UNVERIFIED', 'Could not verify your channel subscription, try again');
  }
  if (!data.subscribed) {
    throw fail(403, data.error ? 'SUBSCRIPTION_UNVERIFIED' : 'SUBSCRIPTION_REQUIRED',
      data.error ? 'Could not verify your channel subscription, try again' : 'Join the channel to spin');
  }
  subCache.set(userId, Date.now());
}

// ---------------------------------------------------------------------------
// External credits: Telegram Stars + TON purchases confirmed by the other services
// ---------------------------------------------------------------------------
const lastCreditPoll = new Map();
async function claimExternalCredits(tgUser, initData) {
  const entries = [];       // { stars, ref }
  if (BOT_URL) {
    try {
      const r = await fetch(`${BOT_URL}/stars/claim-credits`, { headers: { 'X-Telegram-Init-Data': initData }, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        for (const c of d.claimed || []) if (c.stars > 0) entries.push({ stars: Math.trunc(c.stars), ref: `bot:${c.chargeId}` });
      }
    } catch (e) { console.error('⚠️ star credit poll failed:', e.message); }
  }
  if (TON_API_URL) {
    try {
      const r = await fetch(`${TON_API_URL}/ton/claim-credits/${tgUser.id}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        if (d.stars > 0) entries.push({ stars: Math.trunc(d.stars), ref: `ton:${tgUser.id}:${Date.now()}` });
      }
    } catch (e) { console.error('⚠️ TON credit poll failed:', e.message); }
  }
  if (!entries.length) return 0;
  // The other services have already marked these as delivered, so retry hard and
  // leave a loud log (with the charge ids) if the database is down.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await tx(async (c) => {
        await lockUser(c, tgUser);
        let total = 0, tonStars = 0;
        for (const e of entries) {
          const ins = await c.query('INSERT INTO ledger (user_id, kind, stars, ref) VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO NOTHING', [tgUser.id, e.ref.startsWith('ton:') ? 'credit:ton' : 'credit', e.stars, e.ref]);
          if (ins.rowCount) { total += e.stars; if (e.ref.startsWith('ton:')) tonStars += e.stars; }
        }
        // TON purchases count toward promocode access (TON value = Stars x tonPerStar, the same rate as the deposit packages).
        const tonPaid = Math.round(tonStars * Number((CFG.promoAccess || {}).tonPerStar || 0.00932) * 10000) / 10000;
        if (total) await c.query('UPDATE users SET stars = stars + $2, ton_paid = ton_paid + $3, updated_at = NOW() WHERE user_id = $1', [tgUser.id, total, tonPaid]);
        return total;
      });
    } catch (err) {
      console.error(`🚨 crediting purchased Stars failed (attempt ${attempt}):`, err.message);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  console.error('🚨🚨 UNCREDITED PURCHASE — add manually:', JSON.stringify({ user: tgUser.id, entries }));
  return 0;
}

// ---------------------------------------------------------------------------
// Public config (what the app needs to DRAW things; real odds are not included)
// ---------------------------------------------------------------------------
const publicConfig = (() => {
  const wheels = {};
  for (const [name, w] of Object.entries(CFG.wheels)) {
    const sum = (f) => w.prizes.filter(f).reduce((a, r) => a + r.chance, 0) / 100;
    wheels[name] = {
      price: w.price,
      preview: w.preview,
      nftChance: sum((r) => r.type === 'gift' && NFT_SET.has(r.value)),
      giftChance: sum((r) => r.type === 'gift'),
    };
  }
  return { wheels, multipliers: CFG.multipliers, coinValues: CFG.coinValues, nftGifts: CFG.nftGifts, dailyCooldownMs: DAILY_MS };
})();

app.get('/', (req, res) => res.json({ status: 'online', service: 'VoidGifts game server', wheels: Object.keys(CFG.wheels) }));
app.get('/api/config', (req, res) => res.set('Cache-Control', 'public, max-age=60').json(publicConfig));

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------
async function loadState(userId) {
  const u = (await pool.query('SELECT * FROM users WHERE user_id = $1', [userId])).rows[0];
  const inv = (await pool.query(
    `SELECT prize_id, gift_name, status, created_at, scheduled_for FROM prizes
      WHERE user_id = $1 AND status NOT IN ('claimed','converted') ORDER BY created_at DESC LIMIT 500`, [userId])).rows;
  const last = u && u.daily_last_at ? new Date(u.daily_last_at).getTime() : 0;
  const remaining = Math.max(0, last + DAILY_MS - Date.now());
  return {
    balance: u ? bal(u) : { stars: 0, coins: 0, stars_spent: 0 },
    show_in_leaderboard: u ? u.show_in_leaderboard : true,
    promo: promoAccess(u || {}),
    daily: { ready: remaining === 0, remaining_ms: remaining, last_at: last || null },
    inventory: inv.map((r) => ({
      prize_id: r.prize_id, gift_name: r.gift_name, status: r.status,
      created_at: r.created_at, scheduled_for: r.scheduled_for,
    })),
  };
}

app.get('/api/me', auth, limit('me', 40, 10000), wrap(async (req, res) => {
  await tx((c) => lockUser(c, req.user));
  const last = lastCreditPoll.get(req.user.id) || 0;
  let credited = 0;
  if (Date.now() - last > 15000) {
    lastCreditPoll.set(req.user.id, Date.now());
    credited = await claimExternalCredits(req.user, req.get('x-telegram-init-data'));
  }
  res.set('Cache-Control', 'no-store').json({ ...(await loadState(req.user.id)), credited });
}));

// Called right after a purchase: collects Stars as soon as the payment service has them.
app.post('/api/credits/claim', auth, limit('credits', 20, 10000), wrap(async (req, res) => {
  const credited = await claimExternalCredits(req.user, req.get('x-telegram-init-data'));
  res.set('Cache-Control', 'no-store').json({ credited, balance: (await loadState(req.user.id)).balance });
}));

app.post('/api/profile', auth, limit('profile', 10, 10000), wrap(async (req, res) => {
  const show = req.body && typeof req.body.show_in_leaderboard === 'boolean' ? req.body.show_in_leaderboard : null;
  await tx(async (c) => {
    await lockUser(c, req.user);
    if (show !== null) await c.query('UPDATE users SET show_in_leaderboard = $2 WHERE user_id = $1', [req.user.id, show]);
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Spins
// ---------------------------------------------------------------------------
app.post('/api/spin', auth, limit('spin', 12, 10000), wrap(async (req, res) => {
  const wheel = String((req.body || {}).wheel || '');
  const mult = Number((req.body || {}).mult || 1);
  const w = CFG.wheels[wheel];
  if (!w || !(w.price > 0)) throw fail(400, 'UNKNOWN_WHEEL', 'Unknown wheel');
  if (!CFG.multipliers.includes(mult)) throw fail(400, 'BAD_MULTIPLIER', 'Unsupported multiplier');
  await requireSubscription(req.user.id);

  const total = w.price * mult;
  const out = await tx(async (c) => {
    const u = await lockUser(c, req.user);
    if (Number(u.stars) < total) throw fail(402, 'INSUFFICIENT_STARS', 'Not enough Stars', { need: total, have: Number(u.stars) });
    const afterSpend = Number(u.stars) - total;

    const list = [];
    for (let i = 0; i < mult; i++) list.push(rollOne(w.prizes));
    const g = await grantPrizes(c, req.user, list);

    const upd = await c.query(
      `UPDATE users SET stars = stars - $2 + $3, coins = coins + $4, stars_spent = stars_spent + $2, updated_at = NOW()
        WHERE user_id = $1 RETURNING *`, [req.user.id, total, g.stars, g.coins]);
    await addLedger(c, req.user.id, `spin:${wheel}:x${mult}`, g.stars - total, g.coins,
      { gifts: g.results.filter((r) => r.type === 'gift').map((r) => r.value) });
    return { results: g.results, spent: total, after_spend: { ...bal(u), stars: afterSpend, stars_spent: Number(u.stars_spent) + total }, balance: bal(upd.rows[0]) };
  });
  res.set('Cache-Control', 'no-store').json(out);
}));

app.post('/api/daily', auth, limit('daily', 6, 10000), wrap(async (req, res) => {
  const w = CFG.wheels.daily;
  await requireSubscription(req.user.id);
  const out = await tx(async (c) => {
    const u = await lockUser(c, req.user);
    const last = u.daily_last_at ? new Date(u.daily_last_at).getTime() : 0;
    const remaining = last + DAILY_MS - Date.now();
    if (remaining > 0) throw fail(429, 'DAILY_COOLDOWN', 'Daily gift is on cooldown', { remaining_ms: remaining });
    const g = await grantPrizes(c, req.user, [rollOne(w.prizes)]);
    const upd = await c.query(
      `UPDATE users SET daily_last_at = NOW(), stars = stars + $2, coins = coins + $3, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
      [req.user.id, g.stars, g.coins]);
    await addLedger(c, req.user.id, 'daily', g.stars, g.coins, null);
    return { results: g.results, balance: bal(upd.rows[0]), daily: { ready: false, remaining_ms: DAILY_MS, last_at: Date.now() } };
  });
  res.set('Cache-Control', 'no-store').json(out);
}));

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
app.post('/api/prizes/:id/convert', auth, limit('convert', 30, 10000), wrap(async (req, res) => {
  const out = await tx(async (c) => {
    await lockUser(c, req.user);
    // Only a prize that is still untouched ('pending') and owned by this player can be converted.
    const p = await c.query(
      `UPDATE prizes SET status = 'converted', updated_at = NOW()
        WHERE prize_id = $1 AND user_id = $2 AND status = 'pending' RETURNING gift_name`, [req.params.id, req.user.id]);
    if (!p.rowCount) throw fail(409, 'NOT_CONVERTIBLE', 'This prize can no longer be converted');
    const value = CFG.coinValues[p.rows[0].gift_name];
    if (!value) throw new Error(`no coin value for ${p.rows[0].gift_name}`);
    const upd = await c.query('UPDATE users SET coins = coins + $2, updated_at = NOW() WHERE user_id = $1 RETURNING *', [req.user.id, value]);
    await addLedger(c, req.user.id, 'convert', 0, value, { gift: p.rows[0].gift_name, prize_id: req.params.id });
    return { coins: value, balance: bal(upd.rows[0]) };
  });
  res.json(out);
}));

// ---------------------------------------------------------------------------
// Promocodes
// ---------------------------------------------------------------------------
const promoStatus = (p) => {
  const now = Date.now();
  if (!p.active) return 'disabled';
  if (p.expires_at && new Date(p.expires_at).getTime() <= now) return 'expired';
  if (p.starts_at && new Date(p.starts_at).getTime() > now) return 'scheduled';
  if (p.max_uses != null && p.uses >= p.max_uses) return 'used_up';
  return 'active';
};

app.post('/api/promo', auth, limit('promo', 8, 60000), wrap(async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_\-]{1,40}$/.test(code)) throw fail(404, 'PROMO_INVALID', 'Invalid promocode');
  const out = await tx(async (c) => {
    const u = await lockUser(c, req.user);
    const r = await c.query('SELECT * FROM promocodes WHERE code = $1 FOR UPDATE', [code]);
    const p = r.rows[0];
    // Access is checked BEFORE the code is judged, so an account that may not redeem learns nothing
    // about which codes exist. Codes flagged "open to everyone" skip the payment rule (not the block).
    const acc = promoAccess(u);
    if (!acc.allowed && !(p && p.open_to_all && u.promo_allowed !== false)) {
      if (acc.reason === 'blocked') throw fail(403, 'PROMO_BLOCKED', 'Promocodes are not available for this account');
      throw fail(403, 'PROMO_PAYMENT_REQUIRED', `Promocodes unlock after paying ${acc.required_ton} TON`, { required_ton: acc.required_ton, paid_ton: acc.paid_ton });
    }
    if (!p) throw fail(404, 'PROMO_INVALID', 'Invalid promocode');
    const st = promoStatus(p);
    if (st === 'expired') throw fail(410, 'PROMO_EXPIRED', 'This promocode has expired');
    if (st === 'used_up') throw fail(410, 'PROMO_USED_UP', 'This promocode has run out');
    if (st !== 'active') throw fail(404, 'PROMO_INVALID', 'Invalid promocode');
    const ins = await c.query('INSERT INTO promo_redemptions (code, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [code, req.user.id]);
    if (!ins.rowCount) throw fail(409, 'PROMO_ALREADY', 'Code already redeemed');
    await c.query('UPDATE promocodes SET uses = uses + 1 WHERE code = $1', [code]);

    const gifts = (p.gifts || []).filter((g) => GIFT_NAMES.has(g));
    const created = [];
    for (const g of gifts) created.push({ gift: g, prize_id: await createGift(c, req.user, g) });
    const upd = await c.query('UPDATE users SET coins = coins + $2, stars = stars + $3, updated_at = NOW() WHERE user_id = $1 RETURNING *',
      [req.user.id, Number(p.coins), Number(p.stars)]);
    await addLedger(c, req.user.id, `promo:${code}`, Number(p.stars), Number(p.coins), { gifts });
    return { code, coins: Number(p.coins), stars: Number(p.stars), gifts: created, message_key: p.message_key, balance: bal(upd.rows[0]) };
  });
  res.json(out);
}));

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(503).json({ error: 'ADMIN_API_KEY is not set on the server' });
  if (!hit(`adm:${req.ip}`, 60, 60000)) return res.status(429).json({ error: 'Too many requests' });
  const k = Buffer.from(String(req.get('x-admin-key') || ''));
  const a = Buffer.from(ADMIN_API_KEY);
  if (k.length !== a.length || !crypto.timingSafeEqual(k, a)) return res.status(401).json({ error: 'Bad admin key' });
  next();
}

function parsePromoBody(b) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_\-]{1,40}$/.test(code)) throw fail(400, 'BAD_CODE', 'Code must be 1-40 chars: A-Z 0-9 _ -');
  const rw = b.rewards || {};
  const coins = Math.max(0, Math.trunc(Number(rw.coins) || 0));
  const stars = Math.max(0, Math.trunc(Number(rw.stars) || 0));
  const gifts = Array.isArray(rw.gifts) ? rw.gifts.map(String) : [];
  for (const g of gifts) if (!GIFT_NAMES.has(g)) throw fail(400, 'BAD_GIFT', `Unknown gift "${g}". Valid: ${[...GIFT_NAMES].join(', ')}`);
  if (!coins && !stars && !gifts.length) throw fail(400, 'NO_REWARD', 'A promocode needs at least one reward');
  const date = (v) => { if (v === undefined || v === null || v === '') return null; const d = new Date(v); if (isNaN(d)) throw fail(400, 'BAD_DATE', 'Bad date'); return d.toISOString(); };
  const mu = b.max_uses === undefined || b.max_uses === null || b.max_uses === '' ? null : Math.trunc(Number(b.max_uses));
  if (mu !== null && !(mu >= 1)) throw fail(400, 'BAD_MAX', 'max_uses must be 1 or more (leave empty for unlimited)');
  return { code, active: b.active !== false, open_to_all: b.open_to_all === true, starts_at: date(b.starts_at), expires_at: date(b.expires_at), max_uses: mu, coins, stars, gifts,
    message_key: b.message_key ? String(b.message_key).slice(0, 40) : null, note: b.note ? String(b.note).slice(0, 200) : null };
}

app.get('/admin/promos', adminAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM promocodes ORDER BY created_at DESC');
  res.json({ valid_gifts: [...GIFT_NAMES], promos: rows.map((p) => ({ ...p, status: promoStatus(p) })) });
}));
app.post('/admin/promos', adminAuth, wrap(async (req, res) => {
  const p = parsePromoBody(req.body || {});
  const r = await pool.query(
    `INSERT INTO promocodes (code, active, starts_at, expires_at, max_uses, coins, stars, gifts, message_key, note, open_to_all)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (code) DO UPDATE SET active=$2, starts_at=$3, expires_at=$4, max_uses=$5, coins=$6, stars=$7,
       gifts=$8, message_key=$9, note=$10, open_to_all=$11, updated_at=NOW() RETURNING *`,
    [p.code, p.active, p.starts_at, p.expires_at, p.max_uses, p.coins, p.stars, JSON.stringify(p.gifts), p.message_key, p.note, p.open_to_all]);
  res.json({ ...r.rows[0], status: promoStatus(r.rows[0]) });
}));
app.post('/admin/promos/:code/active', adminAuth, wrap(async (req, res) => {
  const r = await pool.query('UPDATE promocodes SET active = $2, updated_at = NOW() WHERE code = $1 RETURNING *', [req.params.code.toUpperCase(), !!(req.body || {}).active]);
  if (!r.rowCount) throw fail(404, 'NOT_FOUND', 'No such code');
  res.json({ ...r.rows[0], status: promoStatus(r.rows[0]) });
}));
app.post('/admin/promos/:code/expire', adminAuth, wrap(async (req, res) => {
  const r = await pool.query('UPDATE promocodes SET expires_at = NOW(), updated_at = NOW() WHERE code = $1 RETURNING *', [req.params.code.toUpperCase()]);
  if (!r.rowCount) throw fail(404, 'NOT_FOUND', 'No such code');
  res.json({ ...r.rows[0], status: promoStatus(r.rows[0]) });
}));
app.delete('/admin/promos/:code', adminAuth, wrap(async (req, res) => {
  const code = req.params.code.toUpperCase();
  await pool.query('DELETE FROM promo_redemptions WHERE code = $1', [code]);
  const r = await pool.query('DELETE FROM promocodes WHERE code = $1', [code]);
  res.json({ deleted: r.rowCount });
}));
app.post('/admin/users/:id/reset-daily', adminAuth, wrap(async (req, res) => {
  const r = await pool.query('UPDATE users SET daily_last_at = NULL WHERE user_id = $1', [req.params.id]);
  res.json({ ok: r.rowCount === 1 });
}));
// Manual promocode permission: true = allow, false = block, null = back to the automatic (paid) rule.
app.post('/admin/users/:id/promo-access', adminAuth, wrap(async (req, res) => {
  const a = (req.body || {}).allowed;
  if (a !== true && a !== false && a !== null) throw fail(400, 'BAD_VALUE', 'allowed must be true, false or null');
  if (!/^\d{1,15}$/.test(req.params.id)) throw fail(400, 'BAD_ID', 'Bad user id');
  const r = await pool.query(
    `INSERT INTO users (user_id, promo_allowed) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET promo_allowed = $2 RETURNING *`, [req.params.id, a]);
  res.json({ user_id: req.params.id, promo_allowed: r.rows[0].promo_allowed, access: promoAccess(r.rows[0]) });
}));
// Same, for a list of ids (e.g. everyone who already paid before this feature existed).
app.post('/admin/promo-access/bulk', adminAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.user_ids) ? [...new Set(b.user_ids.map(String))].filter((x) => /^\d{1,15}$/.test(x)).slice(0, 5000) : [];
  if (!ids.length) throw fail(400, 'NO_IDS', 'user_ids must be a non-empty array of numeric ids');
  if (b.allowed !== true && b.allowed !== false && b.allowed !== null) throw fail(400, 'BAD_VALUE', 'allowed must be true, false or null');
  const r = await pool.query(
    `INSERT INTO users (user_id, promo_allowed) SELECT x::bigint, $2 FROM unnest($1::text[]) AS x
     ON CONFLICT (user_id) DO UPDATE SET promo_allowed = $2`, [ids, b.allowed]);
  res.json({ updated: r.rowCount });
}));
// Back-fill: set how much TON an account has paid in total (for payments made before this feature).
app.post('/admin/users/:id/ton-paid', adminAuth, wrap(async (req, res) => {
  const ton = Number((req.body || {}).ton);
  if (!Number.isFinite(ton) || ton < 0 || ton > 1e6) throw fail(400, 'BAD_VALUE', 'ton must be a number >= 0');
  const r = await pool.query(`INSERT INTO users (user_id, ton_paid) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET ton_paid = $2 RETURNING *`, [req.params.id, ton]);
  res.json({ user_id: req.params.id, access: promoAccess(r.rows[0]) });
}));
// Support / testing tool: give an account Stars, coins and/or a gift (e.g. an NFT to test claiming on dev).
// Every grant is written to the ledger. Set ADMIN_GRANTS=off to switch this route off entirely.
app.post('/admin/users/:id/grant', adminAuth, wrap(async (req, res) => {
  if (String(process.env.ADMIN_GRANTS || 'on').toLowerCase() === 'off') throw fail(403, 'GRANTS_OFF', 'Admin grants are switched off (ADMIN_GRANTS=off)');
  if (!/^\d{1,15}$/.test(req.params.id)) throw fail(400, 'BAD_ID', 'Bad user id');
  const b = req.body || {};
  const stars = Number(b.stars || 0), coins = Number(b.coins || 0);
  const okInt = (n) => Number.isInteger(n) && n >= 0 && n <= 10000000;
  if (!okInt(stars) || !okInt(coins)) throw fail(400, 'BAD_VALUE', 'stars and coins must be whole numbers between 0 and 10,000,000');
  const gift = b.gift ? String(b.gift) : '';
  if (gift && !GIFT_NAMES.has(gift)) throw fail(400, 'BAD_GIFT', 'Unknown gift name');
  if (!stars && !coins && !gift) throw fail(400, 'NOTHING', 'Give stars, coins or a gift');
  const note = b.note ? String(b.note).slice(0, 200) : null;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = (await c.query(
      `INSERT INTO users (user_id, stars, coins) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET stars = users.stars + $2, coins = users.coins + $3, updated_at = NOW() RETURNING *`,
      [req.params.id, stars, coins])).rows[0];
    let prize_id = null;
    if (gift) prize_id = await createGift(c, { id: req.params.id, username: u.username }, gift);
    await addLedger(c, req.params.id, 'admin:grant', stars, coins, { gift, prize_id, note },
      `admin:${req.params.id}:${Date.now()}:${crypto.randomInt(1e6)}`);
    await c.query('COMMIT');
    res.json({ user_id: req.params.id, stars: Number(u.stars), coins: Number(u.coins), prize_id });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}));
app.get('/admin/users/:id', adminAuth, wrap(async (req, res) => {
  const u = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.params.id])).rows[0];
  const l = (await pool.query('SELECT * FROM ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [req.params.id])).rows;
  res.json({ user: u || null, promo_access: u ? promoAccess(u) : null, ledger: l });
}));

app.get('/admin/panel', (req, res) => res.type('html').send(ADMIN_PANEL_HTML));

// ---------------------------------------------------------------------------
const ADMIN_PANEL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VoidGifts promo admin</title><style>
:root{color-scheme:dark}body{margin:0;background:#0b0b14;color:#e8e8f4;font:15px/1.45 system-ui,sans-serif;padding:18px;max-width:980px;margin-inline:auto}
h1{font-size:1.3rem;margin:0 0 14px}input,select,button,textarea{font:inherit;background:#161628;color:#e8e8f4;border:1px solid #2c2c4a;border-radius:8px;padding:8px 10px}
button{cursor:pointer;background:#2a2450;border-color:#4b3fa0}button:hover{background:#38306a}button.danger{background:#4a1d2c;border-color:#8a2f4a}button.ok{background:#17402c;border-color:#2e8a5a}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;align-items:end}.row label{display:flex;flex-direction:column;font-size:.8rem;color:#9a9ac0;gap:3px}
table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #1f1f38;vertical-align:top}th{font-size:.75rem;color:#9a9ac0;text-transform:uppercase}
.tag{padding:2px 9px;border-radius:99px;font-size:.78rem}.active{background:#17402c;color:#7dffb0}.disabled{background:#33333f;color:#aaa}.expired{background:#4a1d2c;color:#ff9db5}.scheduled{background:#403a17;color:#ffe27d}.used_up{background:#4a2f1d;color:#ffbf8a}
.card{background:#10101e;border:1px solid #23233e;border-radius:14px;padding:14px;margin-top:14px}small{color:#8a8ab0}.acts{display:flex;gap:6px;flex-wrap:wrap}
</style></head><body><h1>🎟 Promocodes</h1>
<div class="card"><div class="row"><label>Admin key<input id="key" type="password" placeholder="ADMIN_API_KEY" style="min-width:260px"></label><button id="load">Load</button><small id="msg"></small></div></div>
<div class="card"><b>Create / update a code</b> <small>(same code = overwrite)</small>
<div class="row"><label>Code<input id="f_code" placeholder="SUMMER50"></label><label>Coins<input id="f_coins" type="number" min="0" value="0" style="width:90px"></label><label>Stars<input id="f_stars" type="number" min="0" value="0" style="width:90px"></label>
<label>Gift (optional)<select id="f_gift"><option value="">— none —</option></select></label><label>Max uses<input id="f_max" type="number" min="1" placeholder="unlimited" style="width:110px"></label></div>
<div class="row"><label>Starts<input id="f_start" type="datetime-local"></label><label>Expires<input id="f_exp" type="datetime-local"></label><label>Note<input id="f_note" placeholder="for my own reference" style="min-width:200px"></label>
<label>Open to everyone<select id="f_open"><option value="false">no (needs access)</option><option value="true">yes (free giveaway)</option></select></label><label>Enabled<select id="f_active"><option value="true">yes</option><option value="false">no</option></select></label><button id="save" class="ok">Save code</button></div></div>
<div class="card"><b>Who can redeem promocodes</b> <small>Accounts unlock automatically after paying the required TON; use this to allow or block someone by hand.</small>
<div class="row"><label>Telegram user id<input id="u_id" placeholder="123456789" style="min-width:180px"></label><button id="u_check">Check</button><button class="ok" id="u_allow">Allow</button><button class="danger" id="u_block">Block</button><button id="u_auto">Back to automatic</button><small id="u_msg"></small></div>
<div class="row"><label>Allow many (ids separated by spaces / commas / new lines)<textarea id="u_bulk" rows="2" style="min-width:320px"></textarea></label><button class="ok" id="u_bulkgo">Allow all listed</button></div></div>
<div class="card"><b>Give an account Stars / a gift</b> <small>For testing and support. Every grant is logged. The gift is added to their inventory as a normal prize (ready to claim).</small>
<div class="row"><label>Telegram user id<input id="g_id" placeholder="123456789" style="min-width:180px"></label><label>Stars<input id="g_stars" type="number" min="0" value="0" style="width:100px"></label><label>Coins<input id="g_coins" type="number" min="0" value="0" style="width:100px"></label>
<label>Gift<select id="g_gift"><option value="">— none —</option></select></label><button class="ok" id="g_go">Give</button><small id="g_msg"></small></div></div>
<table><thead><tr><th>Code</th><th>Status</th><th>Rewards</th><th>Uses</th><th>Window</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<script>
const $=id=>document.getElementById(id);let K=sessionStorage.getItem('k')||'';$('key').value=K;
const api=async(m,p,b)=>{const r=await fetch(p,{method:m,headers:{'Content-Type':'application/json','X-Admin-Key':K},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j};
const say=(t,bad)=>{$('msg').textContent=t;$('msg').style.color=bad?'#ff9db5':'#7dffb0'};
const fmt=d=>d?new Date(d).toLocaleString():'—';
async function load(){K=$('key').value.trim();sessionStorage.setItem('k',K);try{const j=await api('GET','/admin/promos');
 if($('f_gift').options.length<2)j.valid_gifts.forEach(g=>{$('f_gift').add(new Option(g,g));$('g_gift').add(new Option(g,g))});
 $('rows').innerHTML=j.promos.map(p=>{const rw=[p.coins>0?p.coins+' coins':'',p.stars>0?p.stars+' ⭐':'',...(p.gifts||[])].filter(Boolean).join(', ');
 return '<tr><td><b>'+p.code+'</b><br><small>'+(p.note||'')+'</small></td><td><span class="tag '+p.status+'">'+p.status.replace('_',' ')+'</span></td><td>'+rw+'</td><td>'+p.uses+(p.max_uses!=null?' / '+p.max_uses:'')+'</td><td><small>'+fmt(p.starts_at)+' →<br>'+fmt(p.expires_at)+'</small></td><td class="acts">'
 +(p.active?'<button data-a="off" data-c="'+p.code+'">Disable</button>':'<button class="ok" data-a="on" data-c="'+p.code+'">Enable</button>')
 +'<button data-a="exp" data-c="'+p.code+'">Expire now</button><button data-a="edit" data-c="'+p.code+'">Edit</button><button class="danger" data-a="del" data-c="'+p.code+'">Delete</button></td></tr>'}).join('')||'<tr><td colspan=6>No codes yet</td></tr>';
 window._p=j.promos;say('Loaded '+j.promos.length+' codes')}catch(e){say(e.message,1)}}
$('load').onclick=load;
$('rows').onclick=async e=>{const b=e.target.closest('button');if(!b)return;const c=b.dataset.c,a=b.dataset.a;try{
 if(a==='off'||a==='on')await api('POST','/admin/promos/'+c+'/active',{active:a==='on'});
 else if(a==='exp')await api('POST','/admin/promos/'+c+'/expire');
 else if(a==='del'){if(!confirm('Delete '+c+'?'))return;await api('DELETE','/admin/promos/'+c)}
 else if(a==='edit'){const p=window._p.find(x=>x.code===c);$('f_code').value=p.code;$('f_coins').value=p.coins;$('f_stars').value=p.stars;$('f_gift').value=(p.gifts||[])[0]||'';$('f_max').value=p.max_uses??'';
  const loc=d=>d?new Date(new Date(d).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';$('f_start').value=loc(p.starts_at);$('f_exp').value=loc(p.expires_at);$('f_note').value=p.note||'';$('f_active').value=String(p.active);$('f_open').value=String(!!p.open_to_all);window.scrollTo(0,0);return}
 await load()}catch(e){say(e.message,1)}};
$('save').onclick=async()=>{try{const g=$('f_gift').value;await api('POST','/admin/promos',{code:$('f_code').value,active:$('f_active').value==='true',open_to_all:$('f_open').value==='true',max_uses:$('f_max').value,
 starts_at:$('f_start').value||null,expires_at:$('f_exp').value||null,note:$('f_note').value,rewards:{coins:+$('f_coins').value,stars:+$('f_stars').value,gifts:g?[g]:[]}});say('Saved');await load()}catch(e){say(e.message,1)}};
const umsg=(t,bad)=>{$('u_msg').textContent=t;$('u_msg').style.color=bad?'#ff9db5':'#7dffb0'};
const uid=()=>$('u_id').value.trim();
const accTxt=a=>(a.allowed?'CAN redeem':'cannot redeem')+' ('+a.reason.replace('_',' ')+', paid '+a.paid_ton+' / '+a.required_ton+' TON)';
$('u_check').onclick=async()=>{K=$('key').value.trim();try{const j=await api('GET','/admin/users/'+uid());umsg(j.user?accTxt(j.promo_access):'user not found',!j.user)}catch(e){umsg(e.message,1)}};
for(const [id,v] of [['u_allow',true],['u_block',false],['u_auto',null]])$(id).onclick=async()=>{K=$('key').value.trim();try{const j=await api('POST','/admin/users/'+uid()+'/promo-access',{allowed:v});umsg(accTxt(j.access))}catch(e){umsg(e.message,1)}};
$('u_bulkgo').onclick=async()=>{K=$('key').value.trim();try{const ids=$('u_bulk').value.split(/[\\s,;]+/).filter(Boolean);const j=await api('POST','/admin/promo-access/bulk',{user_ids:ids,allowed:true});umsg('Allowed '+j.updated+' accounts')}catch(e){umsg(e.message,1)}};
const gmsg=(t,bad)=>{$('g_msg').textContent=t;$('g_msg').style.color=bad?'#ff9db5':'#7dffb0'};
$('g_go').onclick=async()=>{K=$('key').value.trim();try{const j=await api('POST','/admin/users/'+$('g_id').value.trim()+'/grant',{stars:+$('g_stars').value,coins:+$('g_coins').value,gift:$('g_gift').value});gmsg('Done. Balance now '+j.stars+' ⭐, '+j.coins+' coins'+(j.prize_id?'. Prize '+j.prize_id:''))}catch(e){gmsg(e.message,1)}};
if(K)load();
</script></body></html>`;

// ---------------------------------------------------------------------------
(async () => {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`🎮 Game server on :${PORT}  (subscription gate ${ENFORCE_SUB ? 'ON' : 'off'}, stars via bot ${BOT_URL ? 'ON' : 'off'}, TON ${TON_API_URL ? 'ON' : 'off'})`);
      if (!ADMIN_API_KEY) console.warn('⚠️  ADMIN_API_KEY not set — /admin routes are disabled');
    });
  } catch (e) {
    console.error('❌ startup failed:', e);
    process.exit(1);
  }
})();

module.exports = { app, rollOne, verifyInitData };
