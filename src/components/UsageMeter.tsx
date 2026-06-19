"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface UsageData {
  plan: string;
  used: number;
  includedRows: number;
  remaining: number;
  hardCap: boolean;
  blocked: boolean;
  isAdmin: boolean;
  percentage: number;
}

export default function UsageMeter() {
  const [data, setData] = useState<UsageData | null>(null);

  useEffect(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then(setData)
      .catch(() => null);
  }, []);

  if (!data) return null;

  if (data.isAdmin) {
    return (
      <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl px-4 py-3 flex items-center gap-3">
        <span className="text-indigo-400 text-xs font-bold uppercase tracking-wider">Admin</span>
        <span className="text-gray-400 text-xs">Unlimited access — all plans unlocked</span>
      </div>
    );
  }

  const barColor =
    data.percentage >= 90
      ? "bg-red-500"
      : data.percentage >= 70
      ? "bg-yellow-500"
      : "bg-indigo-500";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-white text-sm font-medium capitalize">{data.plan} Plan</span>
          {data.hardCap && (
            <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">hard cap</span>
          )}
        </div>
        <Link href="/pricing" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
          Upgrade →
        </Link>
      </div>

      <div className="w-full bg-gray-800 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${data.percentage}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {data.used.toLocaleString()} / {data.includedRows.toLocaleString()} rows this month
        </span>
        {data.blocked ? (
          <span className="text-red-400 font-medium">Limit reached</span>
        ) : (
          <span>{data.remaining.toLocaleString()} remaining</span>
        )}
      </div>
    </div>
  );
}
