"use client";

import { useState } from "react";

/**
 * Shows a token's logo when available. Falls back to a plain circle with
 * the token's first symbol letter when there's no image, or the image URL
 * fails to load — DexScreener doesn't have artwork for every token, and a
 * broken-image icon would be more confusing than a clean placeholder.
 */
export function TokenLogo({ imageUrl, symbol, size = 32 }) {
  const [failed, setFailed] = useState(false);

  const dimension = { width: size, height: size, minWidth: size, minHeight: size };

  if (!imageUrl || failed) {
    return (
      <div
        style={{
          ...dimension,
          borderRadius: "50%",
          background: "var(--surface-2, #1a1a1a)",
          border: "1px solid var(--border, #333)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size * 0.4,
          fontWeight: 600,
          color: "var(--text-muted, #888)",
          flexShrink: 0
        }}
        aria-label={symbol || "Unknown token"}
      >
        {symbol ? symbol.charAt(0).toUpperCase() : "?"}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external, per-token URLs; not worth Next/Image domain config for this
    <img
      src={imageUrl}
      alt={symbol ? `${symbol} logo` : "Token logo"}
      style={{ ...dimension, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
} 
