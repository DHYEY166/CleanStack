import type { ColumnStat } from "@/lib/types";

interface ColumnStatsTableProps {
  columnStats: Record<string, ColumnStat>;
}

export default function ColumnStatsTable({ columnStats }: ColumnStatsTableProps) {
  const columns = Object.entries(columnStats).filter(([col]) => col !== "_signals");
  if (!columns.length) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left text-gray-400 font-medium pb-2 pr-4">Column</th>
            <th className="text-left text-gray-400 font-medium pb-2 pr-4">Type</th>
            <th className="text-right text-gray-400 font-medium pb-2 pr-4">Null %</th>
            <th className="text-right text-gray-400 font-medium pb-2 pr-4">Unique</th>
            <th className="text-left text-gray-400 font-medium pb-2">Samples</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {columns.map(([col, stat]) => {
            const isProblem = stat.null_pct > 20;
            return (
              <tr key={col} className={isProblem ? "bg-red-500/5" : ""}>
                <td className="py-2 pr-4">
                  <span className={`font-mono text-xs ${isProblem ? "text-red-400" : "text-indigo-300"}`}>
                    {col}
                  </span>
                  {isProblem && (
                    <span className="ml-2 text-xs text-red-400/70">⚠</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <span className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
                    {stat.type}
                  </span>
                </td>
                <td className={`py-2 pr-4 text-right font-mono text-xs ${
                  stat.null_pct > 40
                    ? "text-red-400"
                    : stat.null_pct > 10
                    ? "text-yellow-400"
                    : "text-gray-400"
                }`}>
                  {stat.null_pct.toFixed(1)}%
                </td>
                <td className="py-2 pr-4 text-right font-mono text-xs text-gray-400">
                  {stat.unique_count.toLocaleString()}
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    {stat.sample_values.slice(0, 3).map((v, i) => (
                      <span
                        key={i}
                        className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded max-w-[120px] truncate"
                        title={String(v)}
                      >
                        {String(v)}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
