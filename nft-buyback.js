// ============================================
// NFT BUYBACK — players send a collectible to the relayer, get Stars.
// ============================================
// Pure helpers (no Telegram / HTTP calls) so they can be unit-tested.
// Prices live in buyback-prices.json: { items: [{ title, stars, icon }] }.
// `title` must be Telegram's collection name; matching ignores case, spaces
// and punctuation ("Lol Pop" == "lolpop", "Khabib's Papakha" == "khabibspapakha").
// ============================================
const fs = require('fs');
const path = require('path');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function loadPrices(file = path.join(__dirname, 'buyback-prices.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = (raw.items || []).filter((i) => i && i.title && Number(i.stars) > 0)
    .map((i) => ({ title: String(i.title), stars: Math.trunc(Number(i.stars)), icon: i.icon || String(i.title).replace(/[^A-Za-z0-9]/g, '') }));
  const byNorm = new Map(items.map((i) => [norm(i.title), i]));
  return { items, byNorm };
}

// Which gift (if any) arrived in this message, and is it ours to credit?
// Only collectibles that were transferred / upgraded INTO the relayer's chat
// count. Outgoing messages (our own prize transfers) are ignored.
const INCOMING_ACTIONS = new Set(['star_gift_transferred', 'star_gift_upgraded', 'star_gift_assigned']);
function extractIncomingGift(msg) {
  if (!msg || msg.isOutgoing) return null;
  const a = msg.action;
  if (!a || !INCOMING_ACTIONS.has(a.type) || !a.gift) return null;
  const g = a.gift;
  if (g.isUnique === false) return null;
  return {
    title: g.title,
    slug: g.slug,
    num: g.num,
    messageId: msg.id,
    saleKey: `${g.slug || g.title + '#' + g.num}:${msg.id}`, // idempotency key for prize-store
  };
}

module.exports = { norm, loadPrices, extractIncomingGift };
