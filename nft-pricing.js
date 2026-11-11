// ============================================
// NFT BUYBACK AUTO-PRICING
// ============================================
// Source of truth: Telegram's OWN resale market (the "Gifts" market inside
// Telegram), read through the relayer's logged-in account. That is the market
// where a collectible can actually be sold for Stars, so it is the price the
// buyback should be anchored to. No third-party API key, nothing to scrape.
//
// For every collection in buyback-prices.json:
//   1. read the cheapest few resale listings (sorted by price)
//   2. floor  = the DEPTH-th cheapest listing (default 3rd) - one mispriced or
//               bait listing cannot drag the price down/up
//   3. target = floor x payout% (default 80%)
//   4. guard rails decide whether the new price is applied:
//        - fewer than MIN_LISTINGS listings        -> keep old price
//        - change smaller than MIN_CHANGE_PCT      -> keep (no churn)
//        - change larger than MAX_CHANGE_PCT       -> HOLD, wait for an admin
//          (POST /admin/buyback/run?force=1) - protects against a bad read
//
// Pure functions are exported separately so they can be unit-tested.
// ============================================
const fs = require('fs');
const path = require('path');
const { norm } = require('./nft-buyback');

const DEFAULTS = {
  payoutPct: 80,        // Stars paid = floor x this %
  depth: 3,             // use the Nth cheapest listing as "the floor"
  minListings: 3,       // need at least this many listings to trust a floor
  minChangePct: 3,      // ignore moves smaller than this
  maxChangePct: 30,     // hold moves bigger than this for approval
  tonPerStar: 0.00932,  // only for listings priced in TON (same rate as the deposit packages)
  spacingMs: 1500,      // pause between Telegram calls (flood-wait friendly)
  listLimit: 10,
};

// ---------- pure helpers ----------
function floorFromPrices(prices, { depth = DEFAULTS.depth, minListings = DEFAULTS.minListings } = {}) {
  const p = prices.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (p.length < minListings) return null;
  return p[Math.min(depth, p.length) - 1];
}

function targetStars(floor, payoutPct = DEFAULTS.payoutPct) {
  return Math.max(1, Math.floor(floor * payoutPct / 100));
}

// -> { action: 'apply' | 'skip' | 'hold', stars, changePct, reason }
function decide(oldStars, target, { minChangePct = DEFAULTS.minChangePct, maxChangePct = DEFAULTS.maxChangePct, force = false } = {}) {
  if (!(oldStars > 0)) return { action: 'apply', stars: target, changePct: null, reason: 'no previous price' };
  const changePct = ((target - oldStars) / oldStars) * 100;
  if (Math.abs(changePct) < minChangePct) return { action: 'skip', stars: oldStars, changePct, reason: 'change too small' };
  if (Math.abs(changePct) > maxChangePct && !force) return { action: 'hold', stars: oldStars, changePct, reason: `move of ${changePct.toFixed(1)}% exceeds ${maxChangePct}% - needs approval` };
  return { action: 'apply', stars: target, changePct, reason: force && Math.abs(changePct) > maxChangePct ? 'approved by admin' : 'ok' };
}

// A listing's price in Stars (Stars listing as-is, TON listing converted).
function listingStars(g, tonPerStar = DEFAULTS.tonPerStar) {
  const s = g.resellPriceStars;
  if (s != null) return Number(s);
  const nano = g.resellPriceTon;
  if (nano != null && tonPerStar > 0) return Math.round((Number(nano) / 1e9) / tonPerStar);
  return null;
}

// ---------- Telegram access ----------
async function loadGiftIds(client) {
  const options = await client.getStarGiftOptions();
  const map = new Map();
  for (const g of options) if (g.title) map.set(norm(g.title), g.id);
  return map;
}

async function fetchListingPrices(client, giftId, cfg) {
  const page = await client.getStarGiftResaleOptions({ giftId, sort: 'price', limit: cfg.listLimit });
  const out = [];
  for (const g of page) { const s = listingStars(g, cfg.tonPerStar); if (s) out.push(s); }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reprice every item in `items` (objects with .title/.stars, mutated in place when applied).
// Returns a report array; never throws for a single collection failing.
async function repriceAll({ client, items, cfg: over = {}, force = false, dryRun = false, log = () => {} }) {
  const cfg = { ...DEFAULTS, ...over };
  const report = [];
  let ids;
  try { ids = await loadGiftIds(client); } catch (e) { throw new Error(`could not list Telegram gifts: ${e.message}`); }
  for (const item of items) {
    if (item.auto === false) { report.push({ title: item.title, action: 'pinned', stars: item.stars }); continue; }
    const row = { title: item.title, old: item.stars };
    try {
      const id = ids.get(norm(item.title));
      if (id == null) { report.push({ ...row, action: 'unmapped', stars: item.stars, reason: 'collection not found in Telegram gift list' }); continue; }
      const prices = await fetchListingPrices(client, id, cfg);
      const floor = floorFromPrices(prices, cfg);
      if (floor == null) { report.push({ ...row, action: 'skip', stars: item.stars, listings: prices.length, reason: `only ${prices.length} listings` }); await sleep(cfg.spacingMs); continue; }
      const target = targetStars(floor, cfg.payoutPct);
      const d = decide(item.stars, target, { ...cfg, force });
      report.push({ ...row, floor, target, listings: prices.length, ...d });
      if (d.action === 'apply' && !dryRun) item.stars = d.stars;
    } catch (e) {
      report.push({ ...row, action: 'error', stars: item.stars, reason: e.message });
      if (/FLOOD/i.test(e.message)) { log(`⚠️ pricing: Telegram flood wait, stopping this run (${e.message})`); break; }
    }
    await sleep(cfg.spacingMs);
  }
  return report;
}

// ---------- persistence (survives restarts when BUYBACK_STATE_PATH is on a volume) ----------
function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: {} }; }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}
function applyState(items, state) {
  let n = 0;
  for (const i of items) { const s = state.items && state.items[norm(i.title)]; if (s && i.auto !== false && s.stars > 0) { i.stars = s.stars; n++; } }
  return n;
}
function stateFromReport(prev, report) {
  const next = { updated_at: new Date().toISOString(), items: { ...(prev.items || {}) } };
  for (const r of report) {
    const k = norm(r.title), old = next.items[k];
    if (r.action === 'apply') next.items[k] = { title: r.title, stars: r.stars, floor: r.floor, at: next.updated_at, floor_at: next.updated_at };
    else if (r.floor > 0) next.items[k] = { title: r.title, stars: old ? old.stars : r.old, floor: r.floor, at: old ? old.at : next.updated_at, floor_at: next.updated_at };   // keep the price, remember the latest market floor
  }
  return next;
}

module.exports = { DEFAULTS, floorFromPrices, targetStars, decide, listingStars, repriceAll, loadState, saveState, applyState, stateFromReport };
