"use client";

import { useEffect, useState } from "react";

interface QualityGaugeProps {
  score: number | null;
  label: string;
}

function scoreColor(score: number): string {
  if (score < 41) return "#f87171"; // red-400
  if (score < 71) return "#facc15"; // yellow-400
  return "#4ade80";                  // green-400
}

function GaugeSVG({ score }: { score: number }) {
  const [displayed, setDisplayed] = useState(0);

  useEffect(() => {
    let start: number | null = null;
    const duration = 900;
    const target = score;

    function step(ts: number) {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setDisplayed(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }, [score]);

  const radius = 54;
  const cx = 70;
  const cy = 70;
  const circumference = Math.PI * radius; // semicircle
  const offset = circumference * (1 - displayed / 100);
  const color = scoreColor(displayed);

  return (
    <svg width="140" height="90" viewBox="0 0 140 90">
      {/* Track */}
      <path
        d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
        fill="none"
        stroke="#1f2937"
        strokeWidth="12"
        strokeLinecap="round"
      />
      {/* Fill */}
      <path
        d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
        fill="none"
        stroke={color}
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={{ transition: "stroke-dashoffset 0.05s linear, stroke 0.3s" }}
      />
      {/* Score text */}
      <text
        x={cx}
        y={cy - 8}
        textAnchor="middle"
        fontSize="28"
        fontWeight="700"
        fill={color}
        fontFamily="inherit"
      >
        {displayed}
      </text>
    </svg>
  );
}

export default function QualityGauge({ score, label }: QualityGaugeProps) {
  if (score == null) {
    return (
      <div className="flex flex-col items-center gap-1">
        <div className="w-[140px] h-[90px] flex items-end justify-center">
          <span className="text-5xl font-bold text-gray-600">—</span>
        </div>
        <span className="text-gray-500 text-sm">{label}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <GaugeSVG score={score} />
      <span className="text-gray-400 text-sm">{label}</span>
    </div>
  );
}
