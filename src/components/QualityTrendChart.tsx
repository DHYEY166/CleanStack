"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface TrendPoint {
  run_index: number;
  score: number;
  label: string;
}

interface QualityTrendChartProps {
  data: TrendPoint[];
}

function dot(score: number): string {
  if (score < 41) return "#f87171";
  if (score < 71) return "#facc15";
  return "#4ade80";
}

export default function QualityTrendChart({ data }: QualityTrendChartProps) {
  if (data.length < 2) {
    return (
      <p className="text-gray-500 text-sm text-center py-4">
        Need at least 2 completed runs to show trend.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fill: "#6b7280", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: "#6b7280", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            background: "#111827",
            border: "1px solid #374151",
            borderRadius: "8px",
            color: "#f9fafb",
            fontSize: "12px",
          }}
          formatter={(value) => [`${value ?? ""}`, "Quality Score"]}
          labelFormatter={(label) => `Run ${label}`}
        />
        <ReferenceLine y={70} stroke="#374151" strokeDasharray="3 3" />
        <ReferenceLine y={40} stroke="#374151" strokeDasharray="3 3" />
        <Line
          type="monotone"
          dataKey="score"
          stroke="#6366f1"
          strokeWidth={2}
          dot={({ cx, cy, payload }) => (
            <circle
              key={`dot-${payload.run_index}`}
              cx={cx}
              cy={cy}
              r={4}
              fill={dot(payload.score)}
              stroke="#111827"
              strokeWidth={2}
            />
          )}
          activeDot={{ r: 5, fill: "#6366f1" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
