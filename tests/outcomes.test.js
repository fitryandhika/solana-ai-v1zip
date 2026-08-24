const test = require("node:test");
const assert = require("node:assert/strict");

const { HORIZONS, getDueHorizons, buildHorizonPatch, percentChange } = require("../lib/analyzer/outcomes");

test("percentChange computes correctly", () => {
  assert.equal(percentChange(100, 150), 50);
  assert.equal(percentChange(100, 50), -50);
  assert.equal(percentChange(0, 50), null);
  assert.equal(percentChange(null, 50), null);
  assert.equal(percentChange(100, null), null);
});

test("getDueHorizons returns only horizons whose time has passed", () => {
  const discoveredAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago
  const due = getDueHorizons(discoveredAt, Date.now(), new Set());
  const labels = due.map((h) => h.label);

  assert.ok(labels.includes("1m"));
  assert.ok(labels.includes("5m"));
  assert.ok(!labels.includes("15m"));
  assert.ok(!labels.includes("1h"));
});

test("getDueHorizons excludes already-computed horizons", () => {
  const discoveredAt = Date.now() - 60 * 60 * 1000; // 1 hour ago
  const alreadyComputed = new Set(["1m", "5m"]);
  const due = getDueHorizons(discoveredAt, Date.now(), alreadyComputed);
  const labels = due.map((h) => h.label);

  assert.ok(!labels.includes("1m"));
  assert.ok(!labels.includes("5m"));
  assert.ok(labels.includes("15m"));
  assert.ok(labels.includes("1h"));
});

test("getDueHorizons returns nothing when discovery was just now", () => {
  const due = getDueHorizons(Date.now(), Date.now(), new Set());
  assert.equal(due.length, 0);
});

test("buildHorizonPatch returns null when no outcome snapshot is available yet", () => {
  const patch = buildHorizonPatch("5m", { price: 1, liquidity: 1000 }, null);
  assert.equal(patch, null);
});

test("buildHorizonPatch computes price change for a plain horizon", () => {
  const discovery = { price: 1, liquidity: 1000 };
  const outcome = { price: 1.25, liquidity: 900 };
  const patch = buildHorizonPatch("5m", discovery, outcome);

  assert.equal(patch.price_change_pct_5m, 25);
  assert.equal(patch.liquidity_change_pct_5m, undefined);
});

test("buildHorizonPatch includes liquidity fields and rug flag for 1h/24h", () => {
  const discovery = { price: 1, liquidity: 1000 };
  const outcome = { price: 0.5, liquidity: 150 }; // liquidity dropped 85%

  const patch1h = buildHorizonPatch("1h", discovery, outcome);
  assert.equal(patch1h.price_change_pct_1h, -50);
  assert.equal(patch1h.liquidity_change_pct_1h, -85);
  assert.equal(patch1h.is_rug_1h, true);

  const patch24h = buildHorizonPatch("24h", discovery, { price: 0.9, liquidity: 950 });
  assert.equal(patch24h.liquidity_change_pct_24h, -5);
  assert.equal(patch24h.is_rug_24h, false);
});

test("HORIZONS covers all required evaluation points", () => {
  const labels = HORIZONS.map((h) => h.label);
  assert.deepEqual(labels, ["1m", "5m", "15m", "30m", "1h", "4h", "6h", "24h"]);
}); 
