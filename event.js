'use strict';
// ============================================================================
//  Timed event (Black Friday) for the NFT buyback. Railway variables on the RELAYER service:
//
//    EVENT_ENABLED              on | off (default off). Off = prices exactly as before.
//    EVENT_START                optional ISO time WITH offset. Empty = starts when EVENT_ENABLED=on.
//    EVENT_END                  ISO time WITH offset (default 2026-11-16T00:00:00+05:00). The price is back to normal at that second, no restart.
//    EVENT_SELL_BONUS_PCT       how far above Telegram's floor price the relayer pays during the event (default 5 = floor x 105%)
//    EVENT_MAX_FLOOR_AGE_HOURS  a floor older than this is not trusted; that collection keeps its normal price (default 24)
//
//  Event price = max(normal price, floor x (100 + bonus) / 100). The floor comes from the auto-pricing runs (BUYBACK_AUTO_PRICING=on or dry).
//  A collection with no fresh floor keeps its normal price and is not shown as "above market" in the app.
// ============================================================================
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

function createEvent({ env = process.env, now = () => Date.now() } = {}) {
  const flag = String(env.EVENT_ENABLED || 'off').toLowerCase() === 'on';
  const startMs = env.EVENT_START ? Date.parse(env.EVENT_START) : 0;
  const endMs = Date.parse(env.EVENT_END || '2026-11-16T00:00:00+05:00');
  const bonus = Math.min(50, Math.max(0, num(env.EVENT_SELL_BONUS_PCT, 5)));
  const maxAgeMs = Math.max(1, num(env.EVENT_MAX_FLOOR_AGE_HOURS, 24)) * 3600 * 1000;
  const problems = [];
  if (flag && !Number.isFinite(endMs)) problems.push('EVENT_END is not a valid date (use e.g. 2026-11-16T00:00:00+05:00)');
  if (flag && env.EVENT_START && !Number.isFinite(startMs)) problems.push('EVENT_START is not a valid date');
  const enabled = flag && problems.length === 0;
  const active = () => enabled && now() >= (startMs || 0) && now() < endMs;
  return {
    flag, enabled, problems, bonus, active,
    // base = normal price (Stars). floor = Telegram floor {floor, at} or undefined. -> { stars, base, market }
    price(base, floorInfo) {
      if (!active() || !floorInfo || !(floorInfo.floor > 0) || now() - Date.parse(floorInfo.at || 0) > maxAgeMs) return { stars: base, base, market: 0 };
      const ev = Math.floor(floorInfo.floor * (100 + bonus) / 100);
      return { stars: Math.max(base, ev), base, market: floorInfo.floor };
    },
    public() { return enabled ? { active: active(), starts_at: startMs ? new Date(startMs).toISOString() : null, ends_at: new Date(endMs).toISOString(), bonus_pct: bonus } : { active: false }; },
    describe() {
      if (!flag) return '🎄 Event: off';
      if (!enabled) return `⚠️  Event NOT started: ${problems.join('; ')}`;
      return `🎉 Event ${active() ? 'ACTIVE' : (now() < (startMs || 0) ? 'scheduled' : 'finished')}: sell price = floor +${bonus}%, ends ${new Date(endMs).toISOString()}`;
    },
  };
}
module.exports = { createEvent };
