"use client";

import { useEffect, useRef } from "react";

/**
 * Minimal, dependency-free line chart drawn on a <canvas>. Avoids pulling in
 * a charting library for a simple V1 sparkline-style price/volume view built
 * from stored snapshots (spec section 25).
 */
export default function PriceChart({ snapshots, field = "price", label = "Price", color = "#7c8cff" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const values = (snapshots || [])
      .map((s) => (s[field] !== null && s[field] !== undefined ? Number(s[field]) : null))
      .filter((v) => v !== null && !Number.isNaN(v));

    if (values.length < 2) {
      ctx.fillStyle = "#5b6270";
      ctx.font = "12px sans-serif";
      ctx.fillText("Not enough snapshot data yet", 10, height / 2);
      return;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const padding = 8;

    ctx.beginPath();
    values.forEach((value, idx) => {
      const x = padding + (idx / (values.length - 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / range) * (height - padding * 2);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [snapshots, field, color]);

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
      <canvas ref={canvasRef} width={600} height={140} style={{ width: "100%", height: 140 }} />
    </div>
  );
}
