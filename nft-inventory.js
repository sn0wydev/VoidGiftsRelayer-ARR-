// ============================================
// NFT INVENTORY HELPERS
// ============================================
// Pure functions (no Telegram calls) for finding "a collectible of the
// requested TYPE" in the relayer's own inventory.
//
// Telegram collectibles ("unique gifts") all carry a collection `title`
// (e.g. "Lol Pop"). Every copy of that collection has the same title but
// its own random model, backdrop and symbol, plus a number (#1234) and a
// slug ("LolPop-1234"). The player is promised "a Lollipop" — any copy is
// fine — so we match on the TITLE only and ignore model/backdrop/symbol.
// ============================================

// "Lol Pop", "lolpop", "LOL-POP" -> "lolpop".  Makes matching forgiving about
// spaces, case and punctuation.
function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toNum(v) {
  if (v == null) return null;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Both mtcute generations hand back differently-shaped list items:
//   0.32+  SavedStarGift  (.gift, .messageId, .savedId, .canTransferAt, .transferStars)
//   0.19   UserStarGift   (.gift, .messageId, .transferStars)
// This flattens either into one plain object, or null for anything that is
// not a collectible (regular gifts can't be transferred).
function describeItem(item) {
  const g = item?.gift;
  if (!g || !g.isUnique) return null;
  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const canTransferAt = item.canTransferAt instanceof Date ? item.canTransferAt : null;
  return {
    title: g.title,
    slug: g.slug,
    num: g.num,
    model: safe(() => g.model?.name),
    backdrop: safe(() => g.backdrop?.name),
    pattern: safe(() => g.pattern?.name),
    messageId: item.messageId ?? null,
    canTransferAt,
    transferStars: toNum(item.transferStars) || 0,
    item,
  };
}

// Choose which owned collectible to give away for a prize of `titles`.
//   - any model/backdrop/symbol is accepted — only the collection title counts
//   - skips copies Telegram won't let us move yet (can_transfer_at in the future)
//   - skips copies that cost more Stars to transfer than maxTransferStars
//   - skips copies already reserved by another in-flight claim
//   - preference: free transfers first, then the cheapest transfer, then the
//     HIGHEST collectible number (the least rare copy), so low-number copies
//     you may want to keep are the last to go.
// Returns { pick, matching, ready } — `pick` is null when nothing can be sent.
function pickCollectible(items, titles, { now = Date.now(), maxTransferStars = 100, reserved = new Set() } = {}) {
  const wanted = new Set((titles || []).map(normTitle).filter(Boolean));
  const matching = (items || [])
    .map(describeItem)
    .filter((d) => d && wanted.has(normTitle(d.title)));

  const ready = matching.filter((d) =>
    !reserved.has(d.slug) &&
    (!d.canTransferAt || d.canTransferAt.getTime() <= now) &&
    d.transferStars <= maxTransferStars
  );

  ready.sort((a, b) =>
    (a.transferStars - b.transferStars) ||
    ((b.num || 0) - (a.num || 0))
  );

  return { pick: ready[0] || null, matching, ready };
}

// Group everything we own by collection title (for the admin inventory view
// and the startup log) — also tells you the exact titles to put in the catalog.
function summarize(items) {
  const byTitle = new Map();
  for (const it of items || []) {
    const d = describeItem(it);
    if (!d) continue;
    const key = d.title;
    const row = byTitle.get(key) || { title: key, count: 0, transferableNow: 0, nums: [] };
    row.count++;
    if (!d.canTransferAt || d.canTransferAt.getTime() <= Date.now()) row.transferableNow++;
    if (d.num != null) row.nums.push(d.num);
    byTitle.set(key, row);
  }
  return [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title));
}

module.exports = { normTitle, describeItem, pickCollectible, summarize };
