// lib/utils/format.js
// Shared, dependency-free formatting helpers used by API routes and UI.

/**
 * Format a USD-ish number compactly: 1234 -> "$1.2K", 1234567 -> "$1.2M".
 */
function formatCompactUsd(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const num = Number(value);
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";

  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(abs < 1 ? 6 : 2)}`;
}

/**
 * Format a token price. Very small prices need more decimal precision.
 */
function formatPrice(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const num = Number(value);
  if (num === 0) return "$0";
  if (num >= 1) return `$${num.toFixed(4)}`;
  if (num >= 0.0001) return `$${num.toFixed(6)}`;
  // Very small numbers: show significant digits without excessive zeros.
  return `$${num.toExponential(3)}`;
}

/**
 * Format a percentage change with a leading sign.
 */
function formatPercent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const num = Number(value);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(digits)}%`;
}

/**
 * Format token age in minutes into a short human string: <1m, 12m, 1h, 2h.
 * Returns "—" if ageMinutes is null/undefined (unknown pair creation time).
 */
function formatTokenAge(ageMinutes) {
  if (ageMinutes === null || ageMinutes === undefined || Number.isNaN(Number(ageMinutes))) {
    return "—";
  }
  const mins = Number(ageMinutes);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${Math.floor(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  return `${Math.floor(days)}d`;
}

/**
 * Compute token age in minutes from a pair_created_at (or first_seen_at) timestamp.
 */
function computeTokenAgeMinutes(pairCreatedAt, fallbackFirstSeenAt) {
  const ts = pairCreatedAt || fallbackFirstSeenAt;
  if (!ts) return null;
  const created = new Date(ts).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, (Date.now() - created) / 60000);
}

/**
 * Shorten a Solana address for display: "ABCD...WXYZ".
 */
function shortenAddress(address, lead = 4, trail = 4) {
  if (!address || typeof address !== "string") return "—";
  if (address.length <= lead + trail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-trail)}`;
}

module.exports = {
  formatCompactUsd,
  formatPrice,
  formatPercent,
  formatTokenAge,
  computeTokenAgeMinutes,
  shortenAddress
};
