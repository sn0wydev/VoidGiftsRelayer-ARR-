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

  // Still need getSavedStarGifts titles for these once you own real copies:
  // 'Calendar':      { kind: 'nft', matchTitle: '...' },
  // 'Star Notepad':  { kind: 'nft', matchTitle: '...' },
  // 'Instant Ramen': { kind: 'nft', matchTitle: '...' },
};

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
    headers: { 'Content-Type': 'application/json' },
    ...options
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
    });
  }
  return relayerReady;
}

// In-process dedupe on top of the DB lock — belt and suspenders against
// a double-fire within the same running instance while a send is
// in-flight (the DB lock in prize-store is what actually matters for
// correctness across instances/restarts).
const inFlight = new Set();

// ============================================
// SEND — basic gift, immediate, paid from relayer's Stars balance
// ============================================

async function sendBasicGift({ userId, telegramGiftId, message }) {
  await ensureRelayer();
  return tg.sendStarGift({
    userId,
    gift: telegramGiftId,
    message,
    anonymous: false,
    withUpgrade: false,
  });
}

// ============================================
// TRANSFER — nft gift, from relayer's own gift inventory
// ============================================

async function transferNftGift({ userId, matchTitle }) {
  await ensureRelayer();

  // Pull the relayer's own saved/collectible gifts and find one that's
  // unassigned and matches what was promised at claim time.
  const saved = await tg.call({
    _: 'payments.getSavedStarGifts',
    peer: { _: 'inputPeerSelf' },
    excludeUnsaved: false,
    excludeSaved: false,
    excludeUnlimited: true,
    excludeLimited: false,
    sortByValue: false,
    offset: '',
    limit: 100,
  });

  const candidate = saved.gifts?.find(g =>
    g.gift?.title?.toLowerCase() === matchTitle.toLowerCase() && !g.transferred
  );

  if (!candidate) {
    throw new Error(`No available NFT gift matching "${matchTitle}" in relayer inventory`);
  }

  const inputSavedGift = candidate.gift.slug
    ? { _: 'inputSavedStarGiftSlug', slug: candidate.gift.slug }
    : { _: 'inputSavedStarGiftUser', msgId: candidate.msgId };

  const invoice = {
    _: 'inputInvoiceStarGiftTransfer',
    stargift: inputSavedGift,
    toId: { _: 'inputUserFromMessage' }, // resolved below via getUsers
  };

  // Resolve the target user as an MTProto input peer, then finalize
  // the invoice, get the payment form, and confirm — mirrors the raw
  // flow TDLib's sendGift wraps, but for a transfer instead of a buy.
  const users = await tg.call({
    _: 'users.getUsers',
    id: [{ _: 'inputUser', userId, accessHash: '0' }],
  }).catch(() => null);

  // NOTE: transferring to a user the relayer account has no prior
  // contact/access_hash with can fail here — same "must have some
  // contact" caveat as regular gifting. If you hit this, resolve the
  // user via a prior interaction (e.g. contacts.resolveUsername or a
  // stored access_hash from onboarding) before calling transfer.
  const targetInputUser = users?.[0]
    ? { _: 'inputUser', userId: users[0].id, accessHash: users[0].accessHash }
    : { _: 'inputUserSelf' }; // placeholder — replace with real resolution

  const finalInvoice = { ...invoice, toId: targetInputUser };

  const form = await tg.call({ _: 'payments.getPaymentForm', invoice: finalInvoice });
  const result = await tg.call({
    _: 'payments.sendStarsForm',
    formId: form.formId,
    invoice: finalInvoice,
  });

  return result;
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

  // 1. Resolve what this gift actually is, server-side — BEFORE burning
  // any cooldown. An unknown/unsupported gift name can never succeed,
  // so there's no reason to penalize the user's next real attempt for it.
  const gift = resolveGift(giftName);
  if (!gift) {
    return res.status(400).json({ error: `Unknown gift: ${giftName}` });
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

  try {
    if (gift.kind === 'nft') {
      const scheduledFor = new Date(Date.now() + NFT_DELAY_HOURS * 60 * 60 * 1000).toISOString();
      const schedule = await storeCall(`/prizes/${prizeId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ claim_type: 'nft', scheduled_for: scheduledFor, nft_slug: gift.matchTitle }),
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
      telegramGiftId: gift.telegramGiftId,
      message: GIFT_MESSAGE,
    });
    await storeCall(`/prizes/${prizeId}`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed' }) });

    return res.json({ success: true, claim_type: 'basic', status: 'claimed' });

  } catch (err) {
    console.error(`❌ Claim failed for prize ${prizeId}:`, err.message);
    await releaseCooldown(userId, claimedCooldownAt);
    await storeCall(`/prizes/${prizeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', error_message: err.message }),
    });
    return res.status(500).json({ error: err.message });

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

async function processDueNftTransfers() {
  const due = await storeCall('/prizes/queue/nft-due?limit=20');
  if (!due.ok || !Array.isArray(due.data) || due.data.length === 0) return;

  console.log(`⏳ Processing ${due.data.length} due NFT transfer(s)`);

  for (const prize of due.data) {
    if (inFlight.has(prize.prize_id)) continue;
    inFlight.add(prize.prize_id);
    try {
      await transferNftGift({ userId: prize.user_id, matchTitle: prize.nft_slug || prize.gift_name });
      await storeCall(`/prizes/${prize.prize_id}`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed' }) });
      console.log(`✅ NFT transferred: ${prize.prize_id}`);
    } catch (err) {
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
// HEALTH CHECK
// ============================================

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'gift-relayer' });
});

// ============================================
// STARTUP
// ============================================

const PORT = process.env.PORT || 3003;

async function start() {
  await ensureRelayer();
  app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('🎁 GIFT RELAYER SERVICE (V2)');
    console.log('═══════════════════════════════════════════');
    console.log(`🌐 Running on port ${PORT}`);
    console.log(`⏱  Cooldown: ${COOLDOWN_SECONDS}s | NFT delay: ${NFT_DELAY_HOURS}h`);
    console.log('═══════════════════════════════════════════');
  });

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
