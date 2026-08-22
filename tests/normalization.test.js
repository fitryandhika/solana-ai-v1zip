const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizePair } = require("../lib/providers/dexscreener");
const { formatTokenAge, computeTokenAgeMinutes, formatCompactUsd, shortenAddress } = require("../lib/utils/format");

// ---------------------------------------------------------------------------
// Token normalization (spec section 8: internal shape must be provider-agnostic)
// ---------------------------------------------------------------------------

test("normalizePair maps a DexScreener pair into the internal token shape", () => {
  const fakePair = {
    baseToken: { address: "TokenAddr111", name: "Example Token", symbol: "EXTKN" },
    pairAddress: "PairAddr111",
    dexId: "raydium",
    priceUsd: "0.00042",
    liquidity: { usd: 120000 },
    fdv: 900000,
    volume: { m5: 45000 },
    txns: { m5: { buys: 120, sells: 40 } },
    priceChange: { m5: 12.5 },
    pairCreatedAt: 1700000000000
  };

  const normalized = normalizePair(fakePair);

  assert.equal(normalized.address, "TokenAddr111");
  assert.equal(normalized.symbol, "EXTKN");
  assert.equal(normalized.pairAddress, "PairAddr111");
  assert.equal(normalized.dex, "raydium");
  assert.equal(normalized.price, 0.00042);
  assert.equal(normalized.liquidity, 120000);
  assert.equal(normalized.volume5m, 45000);
  assert.equal(normalized.buys5m, 120);
  assert.equal(normalized.sells5m, 40);
  assert.equal(normalized.priceChange5m, 12.5);
  assert.equal(normalized.dataStatus, "ok");
});

test("normalizePair returns null for a null/undefined pair", () => {
  assert.equal(normalizePair(null), null);
  assert.equal(normalizePair(undefined), null);
});

// ---------------------------------------------------------------------------
// Token age calculation (spec section 9)
// ---------------------------------------------------------------------------

test("computeTokenAgeMinutes prefers pair_created_at over first_seen_at", () => {
  const now = Date.now();
  const pairCreated = new Date(now - 10 * 60000).toISOString();
  const firstSeen = new Date(now - 60 * 60000).toISOString();

  const age = computeTokenAgeMinutes(pairCreated, firstSeen);
  assert.ok(age >= 9.9 && age <= 10.1, `expected ~10 minutes, got ${age}`);
});

test("computeTokenAgeMinutes falls back to first_seen_at when pair time is missing", () => {
  const now = Date.now();
  const firstSeen = new Date(now - 30 * 60000).toISOString();

  const age = computeTokenAgeMinutes(null, firstSeen);
  assert.ok(age >= 29.9 && age <= 30.1, `expected ~30 minutes, got ${age}`);
});

test("computeTokenAgeMinutes returns null when no timestamps are available", () => {
  assert.equal(computeTokenAgeMinutes(null, null), null);
});

test("formatTokenAge produces the documented short strings", () => {
  assert.equal(formatTokenAge(0.5), "<1m");
  assert.equal(formatTokenAge(12), "12m");
  assert.equal(formatTokenAge(90), "1h");
  assert.equal(formatTokenAge(null), "—");
});

// ---------------------------------------------------------------------------
// Formatting / misc utils
// ---------------------------------------------------------------------------

test("formatCompactUsd abbreviates large numbers", () => {
  assert.equal(formatCompactUsd(1200), "$1.2K");
  assert.equal(formatCompactUsd(1_200_000), "$1.20M");
  assert.equal(formatCompactUsd(null), "—");
});

test("shortenAddress truncates long addresses", () => {
  const addr = "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
  const short = shortenAddress(addr);
  assert.equal(short, "AbCd...7890");
});
