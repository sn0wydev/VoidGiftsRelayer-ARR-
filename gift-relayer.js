// ============================================
// GIFT RELAYER SERVICE (V2)
// ============================================
// Deploy as its own Railway service, separate from prize-store and
// from the main bot — this process holds the @VoidGift_Relayer user
// session and can spend its Stars balance, so it gets its own
// isolated credential blast-radius.
//
// Replaces the deprecated vgtserver /claim-gift flow.
//
// Flow implemented:
//   claim request -> verify Telegram initData -> cooldown check ->
//   lock prize in prize-store -> look up gift definition ->
//     basic gift  -> buy+send immediately via relayer's Stars balance
//     nft gift    -> schedule a 48h-delayed transfer from relayer's
//                    own gift inventory, background worker executes it
//
// Env vars required:
//   BOT_TOKEN            - the Mini App's bot token (to verify initData)
//   TG_API_ID/TG_API_HASH - from my.telegram.org, for the relayer's MTProto session
//   MTCUTE_SESSION       - base64 session string for @VoidGift_Relayer
//                          (generate this once, locally, via the login
//                          script at the bottom of this file — never
//                          run interactive login in production)
//   PRIZE_STORE_URL      - e.g. https://vgdatastorage-production.up.railway.app
//   CLAIM_COOLDOWN_SECONDS (default 30)
//   NFT_TRANSFER_DELAY_HOURS (default 48)
//   PORT
// ============================================

// Load variables from a local .env file into process.env.
// Must run before anything below reads process.env.* — that's why
// this is the very first line after the header comment.
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { TelegramClient } = require('@mtcute/node');
const Long = require('long'); // needed to build a valid giftId for sendStarGift — see FIX note in sendBasicGift()
const nftInv = require('./nft-inventory');
const buyback = require('./nft-buyback');

const app = express();
app.use(express.json());

// Mini App frontend runs on a different origin than this relayer, so
// without this the browser blocks every /claim request before it even
// leaves the page — shows up client-side as a generic "Failed to fetch".
// Lock this down to your actual frontend origin(s) once you know them;
// wide open for now to get things unblocked.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PRIZE_STORE_URL = process.env.PRIZE_STORE_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const COOLDOWN_SECONDS = parseInt(process.env.CLAIM_COOLDOWN_SECONDS, 0) || 0;
const NFT_DELAY_HOURS = parseInt(process.env.NFT_TRANSFER_DELAY_HOURS, 10) || 48;
const NFT_WORKER_INTERVAL_MS = 5 * 60 * 1000; // check the due-queue every 5 min
const GIFT_MESSAGE = 'Gift From @VoidGiftsOfficialBot ❤️'; // shown to the recipient when they open a basic gift

// ── NFT claim rules ──
// Each NFT claim needs one fresh qualifying Stars top-up (>= 25 Stars, set by
// NFT_TOPUP_MIN_STARS on prize-store). The main bot records top-ups in
// prize-store; this service "uses one up" per accepted claim.
//   INTERNAL_API_KEY       shared secret for prize-store /internal/* (same value on all 3 services)
//   NFT_TOPUP_REQUIRED     'false' switches the gate off (default on)
//   NFT_MAX_TRANSFER_STARS never pay more than this many Stars to move one collectible (default 100;
//                          Telegram charges a transfer fee on many collectibles)
//   RELAYER_ADMIN_KEY      enables GET /admin/inventory (lists the collectibles the relayer owns)
//   NFT_TITLE_ALIASES      optional JSON, e.g. {"Socks":["Some Real Title"]} — extra collection
//                          titles per catalog gift (see GIFT_CATALOG)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const NFT_TOPUP_REQUIRED = String(process.env.NFT_TOPUP_REQUIRED || 'true').toLowerCase() !== 'false';
const NFT_MAX_TRANSFER_STARS = Number.isFinite(parseInt(process.env.NFT_MAX_TRANSFER_STARS, 10))
  ? parseInt(process.env.NFT_MAX_TRANSFER_STARS, 10) : 100;
const RELAYER_ADMIN_KEY = process.env.RELAYER_ADMIN_KEY;

if (!PRIZE_STORE_URL || !BOT_TOKEN) {
  console.error('❌ Missing required env vars: PRIZE_STORE_URL, BOT_TOKEN');
  process.exit(1);
}

// ============================================
// GIFT CATALOG
// ============================================
// Mirrors NFT_GIFTS / TELEGRAM_GIFT_IDS on the frontend — kept here too
// because the relayer must never trust the client to say whether a
// gift is "basic" or "nft"; a spoofed claim body could otherwise ask
// to skip straight to a free NFT transfer. Server-side is the source
// of truth for what each gift name actually is.
//
// IMPORTANT: the ids in the frontend's TELEGRAM_GIFT_IDS map
// (e.g. 'd01a849b9ef17642d8f4') are NOT real Telegram gift ids — real
// ones are large integers returned by payments.getStarGifts. Run the
// sync script at the bottom once to populate GIFT_CATALOG below with
// real ids before this will actually be able to buy anything.
// ============================================

const GIFT_CATALOG = {
  'Heart':        { telegramGiftId: '5170145012310081615', kind: 'basic' },
  'Bear':         { telegramGiftId: '5170233102089322756', kind: 'basic' },
  'Gift':         { telegramGiftId: '5170250947678437525', kind: 'basic' },
  'Rose':         { telegramGiftId: '5168103777563050263', kind: 'basic' },
  'Cake':         { telegramGiftId: '5170144170496491616', kind: 'basic' },
  'Rose Bouquet': { telegramGiftId: '5170314324215857265', kind: 'basic' },
  'Rocket':       { telegramGiftId: '5170564780938756245', kind: 'basic' },
  'Trophy':       { telegramGiftId: '5168043875654172773', kind: 'basic' },
  'Ring':         { telegramGiftId: '5170690322832818290', kind: 'basic' },
  'Diamond':      { telegramGiftId: '5170521118301225164', kind: 'basic' },
  'Champagne':    { telegramGiftId: '6028601630662853006', kind: 'basic' },

  // ── NFT / collectible gifts ──
  // `matchTitles` = the Telegram COLLECTION name(s) this prize stands for. When a
  // player wins "Lollipop", ANY collectible of that collection satisfies it —
  // regardless of its model, backdrop or symbol (those are random per copy).
  // Titles are matched ignoring case/spaces/punctuation, so "Lol Pop" == "lolpop".
  //
  // The exact collection names must match what Telegram calls them. If a title
  // here is wrong, claims say "out of stock" even though you own copies: open
  // GET /admin/inventory (needs RELAYER_ADMIN_KEY) to see the real titles you
  // own, then fix the entry here or set NFT_TITLE_ALIASES.
  'Lollipop':      { kind: 'nft', matchTitles: ['Lol Pop', 'Lollipop', 'Lolipop'] },
  'Calendar':      { kind: 'nft', matchTitles: ['Desk Calendar', 'Calendar'] },
  'Star Notepad':  { kind: 'nft', matchTitles: ['Star Notepad'] },
  'Instant Ramen': { kind: 'nft', matchTitles: ['Instant Ramen'] },
  'Socks':         { kind: 'nft', matchTitles: ['Fresh Socks', 'Socks'] }, // VERIFY via /admin/inventory
  // Reserved for future cases (not in any wheel yet). Titles are best guesses — confirm with /admin/inventory
  // (or add the real name via NFT_TITLE_ALIASES) before putting them in a live case.
  'Input Key':     { kind: 'nft', matchTitles: ['Input Key', 'InputKey'] },
  'Astral Shard':  { kind: 'nft', matchTitles: ['Astral Shard', 'AstralShard'] },
  'Kissed Frog': { kind: 'nft', matchTitles: ['Kissed Frog', 'KissedFrog'] },
  'Voodoo Doll': { kind: 'nft', matchTitles: ['Voodoo Doll', 'VoodooDoll'] },
  'Vintage Cigar': { kind: 'nft', matchTitles: ['Vintage Cigar', 'VintageCigar'] },
  'Witch Hat': { kind: 'nft', matchTitles: ['Witch Hat', 'WitchHat'] },
  'Light Sword': { kind: 'nft', matchTitles: ['Light Sword', 'LightSword'] },
  'Lucky Locket': { kind: 'nft', matchTitles: ['Lucky Locket', 'LuckyLocket'] },
};

// Optional extra titles from env, merged into the catalog above.
try {
  const extra = JSON.parse(process.env.NFT_TITLE_ALIASES || '{}');
  for (const [name, titles] of Object.entries(extra)) {
    if (GIFT_CATALOG[name]?.kind === 'nft' && Array.isArray(titles)) {
      GIFT_CATALOG[name].matchTitles = [...new Set([...GIFT_CATALOG[name].matchTitles, ...titles.map(String)])];
    }
  }
} catch (e) {
  console.error('⚠️ NFT_TITLE_ALIASES is not valid JSON — ignored:', e.message);
}

function resolveGift(giftName) {
  return GIFT_CATALOG[giftName] || null;
}

// ============================================
// TELEGRAM initData VERIFICATION
// ============================================
// Never trust a client-supplied user_id — this is the same class of
// gap the TON pipeline had before the HMAC hardening pass. Verifies
// the raw initData string Telegram signs for every WebApp session.
// ============================================

function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  // Reject stale sessions — adjust maxAge to taste (24h here).
  const authDate = parseInt(params.get('auth_date'), 10) || 0;
  const maxAgeSeconds = 24 * 60 * 60;
  if (Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;

  try {
    return JSON.parse(userRaw); // { id, username, first_name, ... }
  } catch {
    return null;
  }
}

// ============================================
// PRIZE STORE CLIENT
// ============================================

async function releaseCooldown(userId, claimedCooldownAt) {
  if (!claimedCooldownAt) return; // nothing to release
  try {
    await storeCall(`/users/${userId}/cooldown`, {
      method: 'DELETE',
      body: JSON.stringify({ expected_last_claim_at: claimedCooldownAt }),
    });
  } catch (err) {
    // Non-fatal — worst case the user just has to wait out the cooldown
    // like normal. Don't let this mask the real error being returned.
    console.error(`⚠️ Failed to release cooldown for user ${userId}:`, err.message);
  }
}

async function storeCall(path, options = {}) {
  const res = await fetch(`${PRIZE_STORE_URL}${path}`, {
    ...options,
    // prize-store's prize/cooldown routes require the shared internal key
    headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY || '', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ============================================
// MTCUTE / @VoidGift_Relayer SESSION
// ============================================

const SESSION_PATH = process.env.MTCUTE_SESSION_PATH || 'voidgift-relayer';

// On platforms like Railway, the raw session file never gets committed
// to the repo. Instead it's stored as sealed env vars and decoded back
// into a real file here on boot, before the client tries to open it.
// Railway caps a single variable at 32,768 chars, so a large session
// gets split across MTCUTE_SESSION_B64_0, _1, _2, ... (see
// export-session.js) — collected here in order and concatenated. Also
// supports a single unsplit MTCUTE_SESSION_B64 for small sessions.
//
// IMPORTANT: Railway restarts (crash-restarts included) reuse the same
// container filesystem — a restart is NOT a fresh container. That means
// any leftover local session file survives a crash. We always rebuild
// from the env vars on every boot when they're present, rather than
// trusting whatever's already on disk, so a file left over from a crash
// mid-write can never get "silently reused" as if it were good.
//
// The write itself is atomic (write to a temp file, then rename) so a
// crash DURING the write can never leave a half-written, corrupt session
// file behind either — the old file stays intact until the new one is
// fully written and renamed into place.
const chunks = [];
for (let i = 0; process.env[`MTCUTE_SESSION_B64_${i}`]; i++) {
  chunks.push(process.env[`MTCUTE_SESSION_B64_${i}`]);
}
const sessionB64 = chunks.length ? chunks.join('') : process.env.MTCUTE_SESSION_B64;

if (sessionB64) {
  const tmpPath = `${SESSION_PATH}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.from(sessionB64, 'base64'));
  fs.renameSync(tmpPath, SESSION_PATH); // atomic — never leaves a half-written file on disk
  console.log(`✅ Restored @VoidGift_Relayer session from ${chunks.length ? `${chunks.length} chunked env var(s)` : 'MTCUTE_SESSION_B64'}`);
} else if (!fs.existsSync(SESSION_PATH)) {
  // No env var AND no local file — there is nothing to boot from, and
  // there's no real terminal on Railway to type a phone number into.
  // Fail loudly instead of hanging on a "phone >" prompt no one can see.
  console.error('❌ No MTCUTE_SESSION_B64(_N) env var set, and no local session file exists. Cannot start.');
  process.exit(1);
}

const tg = new TelegramClient({
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  storage: SESSION_PATH,
});

let relayerReady = null;

async function ensureRelayer() {
  if (!relayerReady) {
    relayerReady = tg.start({}).then(() => {
      console.log('✅ @VoidGift_Relayer session connected');
    }).catch((err) => {
      // Don't cache a failed start forever — otherwise one flaky boot
      // makes every later claim reject with the same stale error until
      // the process is restarted. Clear it so the next call retries.
      relayerReady = null;
      throw err;
    });
  }
  return relayerReady;
}

// ============================================
// RECIPIENT RESOLUTION  (fixes "Peer <id> is not found in local cache")
// ============================================
// The relayer is a regular Telegram USER account, not a bot. A user
// account can only message/gift someone whose "access hash" it already
// knows — i.e. someone it has seen (a chat, a contact, a message, a
// username lookup). A brand-new Mini App user the relayer has never
// interacted with is simply unknown, and mtcute throws
//   "Peer 7812623139 is not found in local cache".
//
// Resolution order (first hit wins):
//   1. the relayer's local peer cache (already knows them)
//   2. their @username  -> contacts.resolveUsername (works for anyone
//      with a public username, no prior contact needed). The returned
//      id MUST match the user id from the signed initData, so a renamed /
//      re-used username can never send a gift to the wrong person.
//   3. nothing worked -> RecipientUnreachableError. The user fixes it by
//      opening a chat with the relayer and pressing Start (see the
//      intro listener below, which makes the relayer "meet" them), then
//      tapping Claim again.
// ============================================

const RELAYER_USERNAME = (process.env.RELAYER_USERNAME || 'VoidGift_Relayer').replace(/^@/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RecipientUnreachableError extends Error {
  constructor(userId) {
    super(`The gift account doesn't know you yet. Open @${RELAYER_USERNAME}, press Start, then tap Claim again.`);
    this.name = 'RecipientUnreachableError';
    this.userId = userId;
  }
}

class TopupRequiredError extends Error {
  constructor(requiredStars) {
    super(`Top up at least ${requiredStars} Stars to claim an NFT gift.`);
    this.name = 'TopupRequiredError';
    this.requiredStars = requiredStars;
  }
}

class NftOutOfStockError extends Error {
  constructor(titles, owned) {
    super(`No transferable "${(titles || []).join('" / "')}" collectible available in the relayer inventory (matching owned: ${owned || 0})`);
    this.name = 'NftOutOfStockError';
  }
}

class RelayerConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'RelayerConfigError'; }
}

class StoreUnavailableError extends Error {
  constructor(msg) { super(msg); this.name = 'StoreUnavailableError'; }
}

function isPeerNotFound(err) {
  return (
    err?.constructor?.name === 'MtPeerNotFoundError' ||
    /not found in local cache|was not found|no access hash|PEER_ID_INVALID|USER_ID_INVALID/i.test(err?.message || err?.text || '')
  );
}

async function resolveRecipientOnce(userId, username) {
  const id = Number(userId);

  // 1. Already known to the relayer session?
  try {
    return await tg.resolvePeer(id);
  } catch (err) {
    if (!isPeerNotFound(err)) throw err;
  }

  // 2. Public @username lookup.
  const handle = String(username || '').replace(/^@/, '').trim();
  if (handle) {
    try {
      const peer = await tg.resolvePeer(handle, true);
      if (peer?._ === 'inputPeerUser' && Number(peer.userId) === id) return peer;
      console.warn(`⚠️ @${handle} resolved to a different user than ${id} — ignoring (username reassigned?)`);
    } catch (err) {
      if (!isPeerNotFound(err)) throw err;
    }
  }

  throw new RecipientUnreachableError(id);
}

// Resolution is read-only and idempotent, so (unlike the actual gift
// send) it is safe to retry on transient network/Telegram errors.
async function resolveRecipient(userId, username) {
  await ensureRelayer();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await resolveRecipientOnce(userId, username);
    } catch (err) {
      if (err instanceof RecipientUnreachableError) throw err; // deterministic — retrying won't help
      lastErr = err;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Maps whatever went wrong into a status code, a stable machine-readable
// `code` the Mini App can react to, and a message that makes sense to a
// player (instead of raw MTProto error names).
function classifyClaimError(err) {
  if (err instanceof RecipientUnreachableError) {
    return { status: 422, code: 'PEER_NOT_FOUND', message: err.message, notSent: true };
  }
  if (err instanceof TopupRequiredError) {
    return { status: 402, code: 'TOPUP_REQUIRED', message: err.message, notSent: true, requiredStars: err.requiredStars };
  }
  if (err instanceof NftOutOfStockError) {
    console.error(`🚨 ${err.message}`);
    return { status: 503, code: 'NFT_OUT_OF_STOCK', message: 'This collectible is temporarily out of stock. Please try again later.', notSent: true };
  }
  if (err instanceof RelayerConfigError) {
    console.error(`🚨 ${err.message}`);
    return { status: 503, code: 'RELAYER_UNAVAILABLE', message: 'Gift delivery is temporarily unavailable. Please try again later.', notSent: true };
  }
  if (err instanceof StoreUnavailableError) {
    return { status: 503, code: 'TEMPORARY', message: 'Temporary problem checking your account — please try again in a moment.', notSent: true };
  }
  const raw = String(err?.text || err?.message || err);

  if (/STARGIFT_TRANSFER_TOO_EARLY/i.test(raw)) {
    return { status: 503, code: 'TEMPORARY', message: 'This collectible can\'t be moved yet — please try again later.', notSent: true };
  }
  if (/FLOOD_WAIT|SLOWMODE_WAIT/i.test(raw)) {
    return { status: 429, code: 'RATE_LIMITED', message: 'Telegram is busy right now — please try again in a minute.', notSent: true };
  }
  if (/BALANCE_TOO_LOW|STARS?_BALANCE|NOT_ENOUGH_STARS/i.test(raw)) {
    // This one is on us, not the user — shout in the logs.
    console.error('🚨 RELAYER IS OUT OF STARS — top up @VoidGift_Relayer\'s balance!');
    return { status: 503, code: 'RELAYER_UNAVAILABLE', message: 'Gift delivery is temporarily unavailable. Please try again later.', notSent: true };
  }
  if (/DISALLOW|PRIVACY|USER_IS_BLOCKED/i.test(raw)) {
    return { status: 422, code: 'RECIPIENT_RESTRICTED', message: 'Your Telegram privacy settings don\'t allow receiving gifts. Allow gifts in Settings → Privacy and Security → Gifts, then try again.', notSent: true };
  }
  if (/STARGIFT_USAGE_LIMITED|SOLD_OUT/i.test(raw)) {
    return { status: 409, code: 'GIFT_SOLD_OUT', message: 'This gift is sold out on Telegram right now. Convert it to coins or try again later.', notSent: true };
  }
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|timeout|network|connection/i.test(raw)) {
    // Ambiguous if it happened mid-send, so notSent stays false.
    return { status: 503, code: 'TEMPORARY', message: 'Temporary connection problem — please try again in a moment.', notSent: false };
  }
  return { status: 500, code: 'CLAIM_FAILED', message: raw, notSent: false };
}

// In-process dedupe on top of the DB lock — belt and suspenders against
// a double-fire within the same running instance while a send is
// in-flight (the DB lock in prize-store is what actually matters for
// correctness across instances/restarts).
const inFlight = new Set();

// ============================================
// SEND — basic gift, immediate, paid from relayer's Stars balance
// ============================================

async function sendBasicGift({ userId, username, telegramGiftId, message }) {
  await ensureRelayer();
  // Resolve the recipient ourselves (cache -> @username -> friendly error)
  // instead of letting mtcute throw "Peer … is not found in local cache".
  // mtcute accepts an already-resolved input peer object as `userId`.
  const recipient = await resolveRecipient(userId, username);
  // FIX: mtcute's sendStarGift() builds the raw `inputInvoiceStarGift`
  // internally as `giftId: Long.isLong(gift) ? gift : gift.id`. We were
  // passing `gift` as a plain string (e.g. '5170145012310081615'), which
  // is neither a Long nor an object with an `.id` — so `gift.id` came
  // back `undefined` and Telegram rejected the invoice with "Object
  // inputInvoiceStarGift is missing required property giftId".
  //
  // NOTE: the recipient param was renamed between mtcute generations:
  // 0.19 takes `userId`, 0.20+ takes `peerId`. Passing both works on either
  // (the one that isn't used is simply ignored), so upgrading mtcute can't
  // silently break basic gifts.
  return tg.sendStarGift({
    userId: recipient,
    peerId: recipient,
    gift: Long.fromString(String(telegramGiftId)),
    message,
    anonymous: false,
    withUpgrade: false,
  });
}

// ============================================
// TRANSFER — nft gift, from relayer's own gift inventory
// ============================================
// The relayer OWNS a stock of collectibles (unique gifts). Winning an NFT
// prize means "give the player one collectible of that type" — we pick any
// copy of the right collection (see nft-inventory.js) and transfer it.
//
// Needs @mtcute/node >= 0.20 (Telegram API layer with saved gifts). mtcute
// 0.19 is built on layer 197, which predates the API for listing/transferring
// collectibles by slug — a legacy fallback for it is kept below but the
// supported setup is the version pinned in package.json.
// ============================================

// Collectibles currently being handed over, so two simultaneous claims for
// the same type never grab the same copy.
const reservedNft = new Set();

async function listOwnInventory() {
  await ensureRelayer();
  const all = [];
  let offset;
  for (let page = 0; page < 30; page++) { // hard stop: 3000 items is far beyond any real stock
    const res = typeof tg.getSavedStarGifts === 'function'
      ? await tg.getSavedStarGifts({ owner: 'me', excludeHosted: true, limit: 100, offset })
      : await tg.getStarGifts('me', { limit: 100, offset }); // mtcute 0.19 (layer 197)
    all.push(...res);
    if (!res.next || res.length === 0) break;
    offset = res.next;
  }
  return all;
}

function pickFrom(inventory, titles) {
  return nftInv.pickCollectible(inventory, titles, {
    maxTransferStars: NFT_MAX_TRANSFER_STARS,
    reserved: reservedNft,
  });
}

// Used at claim time: refuse early (and without taking the player's top-up)
// if there is nothing to hand over, instead of failing 48 hours later.
async function assertNftInStock(titles) {
  const { pick, matching } = pickFrom(await listOwnInventory(), titles);
  if (!pick) throw new NftOutOfStockError(titles, matching.length);
}

async function doTransfer(pick, recipient) {
  if (typeof tg.getSavedStarGifts === 'function') {
    // Gifts received by a user account are addressed by their message id;
    // the slug is the fallback. mtcute pays the transfer fee (if any) and
    // handles the "no payment needed" case itself.
    const gift = pick.messageId ? { message: pick.messageId } : pick.slug;
    return tg.transferStarGift({ gift, recipient });
  }
  // mtcute 0.19 legacy API (note its own spelling: `recepient`).
  if (!pick.messageId) throw new Error(`Collectible ${pick.slug} has no message id — cannot transfer with mtcute 0.19`);
  return tg.transferStarGift({ message: pick.messageId, recepient: recipient });
}

async function transferNftGift({ userId, username, titles }) {
  await ensureRelayer();

  // Resolve the recipient FIRST. Previously an unresolvable user silently
  // fell back to `inputUserSelf` (a placeholder), which would have
  // "transferred" the NFT to the relayer itself and still marked the prize
  // as claimed. Now it throws RecipientUnreachableError instead.
  const recipient = await resolveRecipient(userId, username);

  const { pick, matching } = pickFrom(await listOwnInventory(), titles);
  if (!pick) throw new NftOutOfStockError(titles, matching.length);

  reservedNft.add(pick.slug);
  try {
    await doTransfer(pick, recipient);
  } finally {
    reservedNft.delete(pick.slug);
  }
  console.log(`🖼 Transferred ${pick.title} #${pick.num} (${pick.slug}; ${pick.model || '?'} / ${pick.backdrop || '?'}) -> user ${userId}`);
  return pick;
}

// ============================================
// NFT TOP-UP GATE (prize-store /internal/nft-credits)
// ============================================
async function internalCall(path, body) {
  const res = await fetch(`${PRIZE_STORE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Uses up one qualifying (>= 25 Stars) top-up for this prize.
// Returns true if one was consumed, false when the gate is switched off.
async function consumeNftCredit(userId, prizeId) {
  if (!NFT_TOPUP_REQUIRED) return false;
  if (!INTERNAL_API_KEY) {
    throw new RelayerConfigError('NFT top-up gate is ON but INTERNAL_API_KEY is not set on the relayer (set it, or NFT_TOPUP_REQUIRED=false)');
  }
  let r;
  try {
    r = await internalCall('/internal/nft-credits/consume', { user_id: userId, prize_id: prizeId });
  } catch (err) {
    throw new StoreUnavailableError(`prize-store unreachable while checking top-up: ${err.message}`);
  }
  if (r.status === 402) throw new TopupRequiredError(r.data.required_stars || 25);
  if (r.status === 401 || r.status === 503) throw new RelayerConfigError(`prize-store rejected the internal key / is not configured (HTTP ${r.status}) — check INTERNAL_API_KEY on prize-store and the relayer`);
  if (!r.ok) throw new StoreUnavailableError(`prize-store HTTP ${r.status} while checking top-up`);
  return true;
}

async function releaseNftCredit(prizeId) {
  try {
    await internalCall('/internal/nft-credits/release', { prize_id: prizeId });
  } catch (err) {
    console.error(`⚠️ Failed to release NFT credit for prize ${prizeId} — hand it back with /grantnft:`, err.message);
  }
}

// ============================================
// POST /claim
// ============================================
// Body: { initData, prizeId, giftName }
// ============================================

app.post('/claim', async (req, res) => {
  const { initData, prizeId, giftName } = req.body;

  if (!initData || !prizeId || !giftName) {
    return res.status(400).json({ error: 'initData, prizeId, and giftName are required' });
  }

  const user = verifyInitData(initData, BOT_TOKEN);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired Telegram session' });
  }
  const userId = user.id;

  if (inFlight.has(prizeId)) {
    return res.status(409).json({ error: 'This prize is already being processed' });
  }

  // 1. Look the prize up in the store and resolve the gift from what the
  // STORE says it is, never from the client's giftName. Before this, the
  // request's giftName picked what got bought: a user holding a cheap prize
  // (e.g. a Heart) could claim it with giftName "Diamond" and the relayer
  // would send a Diamond from its own Stars balance. This runs BEFORE the
  // cooldown so a bad request can't burn the user's next real attempt.
  const stored = await storeCall(`/prizes/${encodeURIComponent(prizeId)}`);
  if (!stored.ok) {
    return res.status(stored.status === 404 ? 404 : 502).json({
      error: stored.status === 404 ? 'Prize not found' : 'Could not verify prize'
    });
  }
  if (String(stored.data.user_id) !== String(userId)) {
    return res.status(403).json({ error: 'Prize does not belong to this user' });
  }
  if (stored.data.gift_name !== giftName) {
    console.warn(`⚠️ giftName mismatch on prize ${prizeId}: store=${stored.data.gift_name} request=${giftName} user=${userId}`);
    return res.status(400).json({ error: 'giftName does not match this prize' });
  }
  const gift = resolveGift(stored.data.gift_name);
  if (!gift) {
    return res.status(400).json({ error: `Unknown gift: ${stored.data.gift_name}` });
  }

  // 2. Cooldown — DB-backed so it holds even across restarts/instances.
  // Only consumed now that we know this claim can actually proceed.
  const cooldown = await storeCall(`/users/${userId}/cooldown`, {
    method: 'POST',
    body: JSON.stringify({ cooldown_seconds: COOLDOWN_SECONDS }),
  });
  if (!cooldown.ok) {
    return res.status(429).json({ error: 'Please slow down', retry_after: cooldown.data.retry_after });
  }
  // Remember exactly what we just set, so a failed claim below can hand
  // this back to /cooldown (DELETE) and release it — otherwise a claim
  // that fails for an unrelated reason (lock conflict, send error, etc.)
  // still burns the cooldown, and the user's very next honest retry
  // gets bounced with "Please slow down" for something that never
  // actually succeeded.
  const claimedCooldownAt = cooldown.data.last_claim_at;

  // 3. Atomically lock the prize — the real duplicate-claim guard.
  const lock = await storeCall(`/prizes/${prizeId}/lock`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
  if (!lock.ok) {
    await releaseCooldown(userId, claimedCooldownAt);
    return res.status(lock.status).json({ error: lock.data.error || 'Could not lock prize for claiming' });
  }

  inFlight.add(prizeId);

  // Prefer the fresh username from the signed initData; fall back to the
  // one saved with the prize when it was won.
  const username = user.username || stored.data.username || null;

  let creditConsumed = false; // an NFT top-up credit tied to this claim (handed back if the claim fails)

  try {
    // Check the recipient is reachable BEFORE doing anything irreversible
    // (for NFTs this means the player finds out now, not 48 hours later).
    await resolveRecipient(userId, username);

    if (gift.kind === 'nft') {
      // 1. Make sure we actually have a copy to hand over (any model/backdrop
      //    of the right collection) BEFORE taking the player's top-up.
      await assertNftInStock(gift.matchTitles);
      // 2. Every NFT claim needs its own fresh >= 25 Stars top-up. Throws
      //    TopupRequiredError (-> HTTP 402) when there isn't one.
      creditConsumed = await consumeNftCredit(userId, prizeId);

      const scheduledFor = new Date(Date.now() + NFT_DELAY_HOURS * 60 * 60 * 1000).toISOString();
      const schedule = await storeCall(`/prizes/${prizeId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ claim_type: 'nft', scheduled_for: scheduledFor, nft_slug: gift.matchTitles[0] }),
      });
      if (!schedule.ok) throw new Error(schedule.data.error || 'Failed to schedule NFT transfer');

      return res.json({
        success: true,
        claim_type: 'nft',
        status: 'queued_nft',
        scheduled_for: scheduledFor,
      });
    }

    // basic gift — send now
    await sendBasicGift({
      userId,
      username,
      telegramGiftId: gift.telegramGiftId,
      message: GIFT_MESSAGE,
    });
    await storeCall(`/prizes/${prizeId}`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed' }) });

    return res.json({ success: true, claim_type: 'basic', status: 'claimed' });

  } catch (err) {
    const info = classifyClaimError(err);
    console.error(`❌ Claim failed for prize ${prizeId} (${info.code}):`, err.message);
    await releaseCooldown(userId, claimedCooldownAt);
    // Nothing got queued/sent, so the player keeps their top-up for next time.
    if (creditConsumed) await releaseNftCredit(prizeId);

    // If we know nothing was sent (couldn't resolve the user, rate limit,
    // our balance empty…) put the prize straight back to 'pending' so it
    // looks untouched and can simply be retried. Anything ambiguous (e.g.
    // a timeout mid-send) stays 'failed' with the error recorded, so a
    // human can check before it's re-sent.
    await storeCall(`/prizes/${prizeId}`, {
      method: 'PATCH',
      body: JSON.stringify(
        info.notSent
          ? { status: 'pending' }
          : { status: 'failed', error_message: err.message }
      ),
    });
    return res.status(info.status).json({
      error: info.message,
      code: info.code,
      relayer_username: RELAYER_USERNAME,
      ...(info.requiredStars ? { required_stars: info.requiredStars } : {}),
    });

  } finally {
    inFlight.delete(prizeId);
  }
});

// ============================================
// GET /claim-status/:prizeId
// ============================================
// Called by: frontend, to poll a queued NFT transfer's status/countdown.
// ============================================

app.get('/claim-status/:prizeId', async (req, res) => {
  const result = await storeCall(`/prizes/${req.params.prizeId}`);
  if (!result.ok) return res.status(result.status).json(result.data);
  res.json(result.data);
});

// ============================================
// BACKGROUND WORKER — executes due NFT transfers
// ============================================

// prize_id -> timestamp before which we won't re-try it (used when the
// recipient just isn't reachable yet, so we don't hammer Telegram or spam
// the logs every 5 minutes).
const nftRetryAfter = new Map();

// Which collection title(s) a queued prize stands for: the catalog entry for
// its gift name, or — for admin-added prizes with a custom type — the typed value.
function nftTitlesFor(prize) {
  const entry = resolveGift(prize.gift_name);
  if (entry?.kind === 'nft') return entry.matchTitles;
  return [prize.nft_slug || prize.gift_name];
}
const NFT_UNREACHABLE_RETRY_MS = 30 * 60 * 1000;

async function processDueNftTransfers() {
  const due = await storeCall('/prizes/queue/nft-due?limit=20');
  if (!due.ok || !Array.isArray(due.data) || due.data.length === 0) return;

  console.log(`⏳ Processing ${due.data.length} due NFT transfer(s)`);

  for (const prize of due.data) {
    if (inFlight.has(prize.prize_id)) continue;
    if ((nftRetryAfter.get(prize.prize_id) || 0) > Date.now()) continue;
    inFlight.add(prize.prize_id);
    try {
      await transferNftGift({
        userId: prize.user_id,
        username: prize.username,
        titles: nftTitlesFor(prize),
      });
      await storeCall(`/prizes/${prize.prize_id}`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed' }) });
      nftRetryAfter.delete(prize.prize_id);
      console.log(`✅ NFT transferred: ${prize.prize_id}`);
    } catch (err) {
      if (err instanceof RecipientUnreachableError) {
        // Not a real failure — the relayer just hasn't met this user yet.
        // Leave it queued; it'll go through once they open the relayer chat.
        nftRetryAfter.set(prize.prize_id, Date.now() + NFT_UNREACHABLE_RETRY_MS);
        console.warn(`⏸ NFT ${prize.prize_id}: user ${prize.user_id} unreachable, will retry in 30 min`);
        continue;
      }
      if (err instanceof NftOutOfStockError || /STARGIFT_TRANSFER_TOO_EARLY/i.test(String(err?.text || err?.message))) {
        // Nothing to hand over right now (stock ran out, or Telegram's
        // cooldown on a freshly received collectible hasn't passed). Keep the
        // prize queued and try again later rather than failing it.
        nftRetryAfter.set(prize.prize_id, Date.now() + NFT_UNREACHABLE_RETRY_MS);
        console.error(`🚨 NFT ${prize.prize_id} (${prize.gift_name}) waiting for stock: ${err.message}`);
        continue;
      }
      console.error(`❌ NFT transfer failed for ${prize.prize_id}:`, err.message);
      await storeCall(`/prizes/${prize.prize_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', error_message: err.message }),
      });
    } finally {
      inFlight.delete(prize.prize_id);
    }
  }
}

// ============================================
// GET /admin/inventory — what collectibles does the relayer own?
// ============================================
// Header: x-admin-key = RELAYER_ADMIN_KEY (endpoint is disabled if unset).
// Shows every collection title you own with counts, and which catalog gift
// each maps to — use it to check the titles in GIFT_CATALOG are right.
// ============================================
app.get('/admin/inventory', async (req, res) => {
  if (!RELAYER_ADMIN_KEY) return res.status(503).json({ error: 'RELAYER_ADMIN_KEY not set — endpoint disabled' });
  if (req.get('x-admin-key') !== RELAYER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const items = await listOwnInventory();
    const collections = nftInv.summarize(items);
    const catalog = Object.entries(GIFT_CATALOG)
      .filter(([, g]) => g.kind === 'nft')
      .map(([name, g]) => {
        const { matching, ready } = nftInv.pickCollectible(items, g.matchTitles, { maxTransferStars: NFT_MAX_TRANSFER_STARS });
        return { gift: name, matchTitles: g.matchTitles, owned: matching.length, readyToSend: ready.length };
      });
    const known = new Set(Object.values(GIFT_CATALOG).filter((g) => g.kind === 'nft').flatMap((g) => g.matchTitles.map(nftInv.normTitle)));
    res.json({
      totalCollectibles: collections.reduce((n, c) => n + c.count, 0),
      collections,
      catalog,
      unmappedTitles: collections.map((c) => c.title).filter((t) => !known.has(nftInv.normTitle(t))),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'gift-relayer' });
});

// ============================================
// STARTUP
// ============================================

const PORT = process.env.PORT || 3003;

// ============================================
// INTRO LISTENER — lets players "introduce" themselves to the relayer
// ============================================
// When a player who has no public @username (or whose lookup failed) gets
// the "open @VoidGift_Relayer and press Start" message, the first message
// they send makes Telegram hand the relayer that user + their access hash,
// which mtcute caches — from then on resolveRecipient() finds them in its
// local cache. We reply once so the player knows it worked.
// Set RELAYER_AUTOREPLY=off to disable the reply (peer caching still works).
// ============================================
// ============================================
// NFT BUYBACK — a player sends us a collectible, we credit Stars in the app
// ============================================
// prize-store records the sale once (idempotent on sale_key) and adds the Stars
// to the sender's balance; the app picks it up the next time it syncs.
// Set NFT_BUYBACK=off to disable. Needs INTERNAL_API_KEY (same as the top-up gate).
// ============================================
const NFT_BUYBACK = (process.env.NFT_BUYBACK || 'on').toLowerCase() !== 'off';
const BUYBACK = buyback.loadPrices();
console.log(`💱 NFT buyback: ${NFT_BUYBACK ? 'ON' : 'off'} — ${BUYBACK.items.length} priced collections`);

app.get('/buyback/prices', (req, res) => {
  res.json({ enabled: NFT_BUYBACK, relayer_username: RELAYER_USERNAME, items: BUYBACK.items });
});

async function recordSale(sale, attempt = 1) {
  try {
    const r = await internalCall('/internal/nft-sales', sale);
    if (r.ok) return r.data;
    if (r.status === 401 || r.status === 503) throw new RelayerConfigError(`prize-store rejected the internal key (HTTP ${r.status}) — check INTERNAL_API_KEY`);
    throw new Error(`HTTP ${r.status} ${JSON.stringify(r.data)}`);
  } catch (err) {
    if (err instanceof RelayerConfigError || attempt >= 6) throw err;
    await new Promise((res) => setTimeout(res, Math.min(60000, 2000 * 2 ** attempt)));
    return recordSale(sale, attempt + 1);
  }
}

async function handleIncomingGift(msg) {
  if (!NFT_BUYBACK) return false;
  const gift = buyback.extractIncomingGift(msg);
  if (!gift) return false;
  const sender = msg.sender;
  if (!sender || sender.isSelf) return false;
  const entry = BUYBACK.byNorm.get(buyback.norm(gift.title));
  const reply = (t) => tg.sendText(msg.chat.id, t).catch((e) => console.warn('⚠️ buyback reply failed:', e.message));

  if (!entry) {
    console.log(`💱 ${sender.id} sent unpriced collectible "${gift.title}" (${gift.slug}) — no credit`);
    await reply(`❌ We don't buy "${gift.title}" yet, so no Stars were credited. Contact support if you'd like it returned.`);
    return true;
  }
  if (!INTERNAL_API_KEY) {
    console.error('❌ NFT buyback: INTERNAL_API_KEY not set — cannot credit', gift.slug);
    return true;
  }
  try {
    const out = await recordSale({
      sale_key: gift.saleKey, user_id: sender.id, title: entry.title, slug: gift.slug, num: gift.num, stars: entry.stars,
    });
    if (out.credited) {
      console.log(`💱 Credited ${entry.stars}★ to ${sender.id} for ${gift.title} (${gift.slug})`);
      await reply(`✅ Received ${gift.title}${gift.num ? ' #' + gift.num : ''}. +${entry.stars} ⭐ added to your VoidGifts balance — open the app to see it.`);
    } else {
      console.log(`💱 Sale ${gift.saleKey} already recorded — skipped`);
    }
  } catch (err) {
    // Never silently lose a sale: it is in the logs with everything needed to credit by hand.
    console.error(`❌ NFT buyback FAILED to credit ${entry.stars}★ to ${sender.id} for ${gift.title} ${gift.slug} key=${gift.saleKey}:`, err.message);
    await reply('⚠️ We received your gift but could not credit it right now. Support will fix it — no need to resend.');
  }
  return true;
}

const AUTOREPLY = (process.env.RELAYER_AUTOREPLY || 'on').toLowerCase() !== 'off';
const lastIntroReplyAt = new Map(); // userId -> ms, so we never spam someone

function registerIntroListener() {
  tg.onNewMessage.add(async (msg) => {
    try {
      if (msg.isOutgoing || msg.chat?.type !== 'user') return; // private chats only
      if (await handleIncomingGift(msg)) return;         // a collectible arrived: buy it back, don't send the intro reply
      const sender = msg.sender;
      if (!sender || sender.isBot || sender.isSelf) return;
      console.log(`👋 Relayer met user ${sender.id}`);

      if (!AUTOREPLY) return;
      const last = lastIntroReplyAt.get(sender.id) || 0;
      if (Date.now() - last < 10 * 60 * 1000) return;
      lastIntroReplyAt.set(sender.id, Date.now());

      await tg.sendText(
        msg.chat.id,
        "✅ You're all set! Go back to VoidGifts and tap \"Claim Prize\" again — your gift will arrive here shortly."
      );
    } catch (err) {
      console.error('⚠️ Intro listener error:', err.message);
    }
  });
}

async function start() {
  await ensureRelayer();
  registerIntroListener();
  app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('🎁 GIFT RELAYER SERVICE (V2)');
    console.log('═══════════════════════════════════════════');
    console.log(`🌐 Running on port ${PORT}`);
    console.log(`⏱  Cooldown: ${COOLDOWN_SECONDS}s | NFT delay: ${NFT_DELAY_HOURS}h`);
    console.log('═══════════════════════════════════════════');
  });

  // Log what we can hand out (helps spot wrong catalog titles on first boot).
  listOwnInventory()
    .then((items) => {
      const rows = nftInv.summarize(items);
      console.log(`📦 Collectibles owned: ${rows.length ? rows.map((r) => `${r.title}×${r.count}`).join(', ') : 'none'}`);
    })
    .catch((err) => console.warn('⚠️ Could not read relayer inventory at startup:', err.message));

  setInterval(() => {
    processDueNftTransfers().catch(err => console.error('❌ NFT worker error:', err.message));
  }, NFT_WORKER_INTERVAL_MS);
  processDueNftTransfers().catch(() => {}); // also run once on boot
}

start();

// ============================================
// ONE-TIME SETUP SCRIPTS (do not run in production)
// ============================================
// Run these locally/interactively, NOT as part of the deployed service.
//
// 1. Generate the relayer session (run once, save output as
//    MTCUTE_SESSION_PATH's file, or export the session string and
//    load it as a Railway secret volume):
//
//    node -e "
//      const { TelegramClient } = require('@mtcute/node');
//      const tg = new TelegramClient({ apiId: ..., apiHash: '...', storage: 'voidgift-relayer' });
//      tg.start({ phone: () => '+7...' }).then(() => console.log('done'));
//    "
//
// 2. Sync the real gift catalog (populate GIFT_CATALOG above with
//    actual Telegram gift ids instead of the frontend's placeholders):
//
//    node -e "
//      const { TelegramClient } = require('@mtcute/node');
//      const tg = new TelegramClient({ apiId: ..., apiHash: '...', storage: 'voidgift-relayer' });
//      tg.start({}).then(async () => {
//        const gifts = await tg.call({ _: 'payments.getStarGifts', hash: 0 });
//        console.log(JSON.stringify(gifts.gifts, null, 2));
//      });
//    "
// ============================================
