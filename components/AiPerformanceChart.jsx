"use client";

import { useEffect, useRef } from "react";

/**
 * Minimal, dependency-free bar chart for daily AI performance values (win
 * rate % or avg return %). Follows the same canvas approach as
 * PriceChart.jsx rather than pulling in a charting library.
 */
export default function AiPerformanceChart({ daily, field = "winRate", label = "Win Rate", color = "#7c8cff" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const points = (daily || []).filter((d) => d[field] !== null && d[field] !== undefined);

    if (points.length < 1) {
      ctx.fillStyle = "#5b6270";
      ctx.font = "12px sans-serif";
      ctx.fillText("Belum cukup data untuk grafik ini", 10, height / 2);
      return;
    }

    const values = points.map((d) => d[field]);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = max - min || 1;
    const padding = 10;
    const zeroY = height - padding - ((0 - min) / range) * (height - padding * 2);

    // Zero line — makes it visually obvious when a bar is negative.
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, zeroY);
    ctx.lineTo(width - padding, zeroY);
    ctx.stroke();

    const barWidth = Math.max(2, (width - padding * 2) / points.length - 2);

    points.forEach((point, idx) => {
      const value = point[field];
      const x = padding + (idx / points.length) * (width - padding * 2);
      const barHeight = (Math.abs(value) / range) * (height - padding * 2);
      const y = value >= 0 ? zeroY - barHeight : zeroY;

      ctx.fillStyle = value >= 0 ? "#22c55e" : "#ef4444";
      ctx.fillRect(x, y, barWidth, barHeight || 1);
    });
  }, [daily, field, color]);

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
      <canvas ref={canvasRef} width={600} height={140} style={{ width: "100%", height: 140 }} />
    </div>
  );
}
