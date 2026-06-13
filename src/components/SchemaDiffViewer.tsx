interface DiffEntry {
  col: string;
  fromType?: string;
  toType?: string;
}

interface SchemaDiff {
  added: Record<string, string>;
  removed: Record<string, string>;
  type_changed: Record<string, { from: string; to: string }>;
}

interface SchemaDiffViewerProps {
  diff: SchemaDiff;
}

export default function SchemaDiffViewer({ diff }: SchemaDiffViewerProps) {
  const added: DiffEntry[] = Object.entries(diff.added).map(([col, toType]) => ({
    col,
    toType,
  }));
  const removed: DiffEntry[] = Object.entries(diff.removed).map(([col, fromType]) => ({
    col,
    fromType,
  }));
  const changed: DiffEntry[] = Object.entries(diff.type_changed).map(([col, { from, to }]) => ({
    col,
    fromType: from,
    toType: to,
  }));

  const total = added.length + removed.length + changed.length;
  if (total === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-gray-500">
        {added.length > 0 && (
          <span className="text-green-400">+{added.length} added</span>
        )}
        {removed.length > 0 && (
          <span className="text-red-400">−{removed.length} removed</span>
        )}
        {changed.length > 0 && (
          <span className="text-yellow-400">~{changed.length} type changed</span>
        )}
      </div>

      <div className="rounded-lg border border-gray-800 overflow-hidden font-mono text-xs">
        {added.map(({ col, toType }) => (
          <div key={`add-${col}`} className="flex items-center gap-3 px-3 py-1.5 bg-green-500/5 border-b border-gray-800/50">
            <span className="text-green-400 w-3">+</span>
            <code className="text-green-300 flex-1">{col}</code>
            <span className="text-green-400/60">{toType}</span>
          </div>
        ))}
        {removed.map(({ col, fromType }) => (
          <div key={`rem-${col}`} className="flex items-center gap-3 px-3 py-1.5 bg-red-500/5 border-b border-gray-800/50">
            <span className="text-red-400 w-3">−</span>
            <code className="text-red-300 flex-1">{col}</code>
            <span className="text-red-400/60">{fromType}</span>
          </div>
        ))}
        {changed.map(({ col, fromType, toType }) => (
          <div key={`chg-${col}`} className="flex items-center gap-3 px-3 py-1.5 bg-yellow-500/5 border-b border-gray-800/50">
            <span className="text-yellow-400 w-3">~</span>
            <code className="text-yellow-300 flex-1">{col}</code>
            <span className="text-yellow-400/60">
              {fromType} → {toType}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
