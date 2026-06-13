import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/Nav";
import { queryOne, query } from "@/lib/db";
import type { PipelineRun, DataProfile, TransformRule } from "@/lib/types";
import QualityGauge from "@/components/QualityGauge";
import ColumnStatsTable from "@/components/ColumnStatsTable";
import QualityTrendChart from "@/components/QualityTrendChart";
import SchemaDiffViewer from "@/components/SchemaDiffViewer";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; rid: string }>;
}) {
  const { userId } = await auth();
  const { id, rid } = await params;

  const run = await queryOne<PipelineRun & { pipeline_name: string }>(
    `SELECT pr.*, p.name AS pipeline_name
     FROM pipeline_runs pr
     JOIN pipelines p ON pr.pipeline_id = p.id
     WHERE pr.id = $1 AND p.team_id = $2`,
    [rid, userId]
  );
  if (!run) notFound();

  const [rawProfile, processedProfile, rules, trendRuns, schemaDriftData] = await Promise.all([
    queryOne<DataProfile>(
      "SELECT * FROM data_profiles WHERE run_id = $1 AND stage = 'raw'",
      [rid]
    ),
    queryOne<DataProfile>(
      "SELECT * FROM data_profiles WHERE run_id = $1 AND stage = 'processed'",
      [rid]
    ),
    query<TransformRule>(
      "SELECT * FROM transform_rules WHERE run_id = $1 ORDER BY order_index ASC",
      [rid]
    ),
    query<{ id: string; created_at: string; quality_score: number | null }>(
      `SELECT pr.id, pr.created_at, dp.quality_score
       FROM pipeline_runs pr
       LEFT JOIN data_profiles dp ON dp.run_id = pr.id AND dp.stage = 'processed'
       WHERE pr.pipeline_id = $1 AND pr.status = 'completed'
       ORDER BY pr.created_at ASC
       LIMIT 20`,
      [run.pipeline_id]
    ),
    // Fetch this run's schema snapshot + previous one to detect drift
    query<{ schema_hash: string; column_definitions: Record<string, string>; created_at: string }>(
      `SELECT schema_hash, column_definitions, created_at
       FROM schema_snapshots
       WHERE pipeline_id = $1
       ORDER BY created_at DESC
       LIMIT 2`,
      [run.pipeline_id]
    ),
  ]);

  const trendData = trendRuns
    .filter((r) => r.quality_score != null)
    .map((r, i) => ({
      run_index: i + 1,
      score: r.quality_score!,
      label: `#${i + 1}`,
    }));

  const statusColors: Record<string, string> = {
    pending: "text-yellow-400",
    profiling: "text-blue-400",
    awaiting_ai: "text-purple-400",
    awaiting_approval: "text-orange-400",
    queued: "text-yellow-400",
    running: "text-blue-400",
    completed: "text-green-400",
    failed: "text-red-400",
  };

  const delta =
    rawProfile?.quality_score != null && processedProfile?.quality_score != null
      ? processedProfile.quality_score - rawProfile.quality_score
      : null;

  // Build schema diff if two snapshots exist and hashes differ
  let schemaDiff: { added: Record<string, string>; removed: Record<string, string>; type_changed: Record<string, { from: string; to: string }> } | null = null;
  if (schemaDriftData.length === 2) {
    const [current, previous] = schemaDriftData;
    if (current.schema_hash !== previous.schema_hash) {
      const oldCols = previous.column_definitions as Record<string, string>;
      const newCols = current.column_definitions as Record<string, string>;
      schemaDiff = {
        added: Object.fromEntries(Object.entries(newCols).filter(([k]) => !(k in oldCols))),
        removed: Object.fromEntries(Object.entries(oldCols).filter(([k]) => !(k in newCols))),
        type_changed: Object.fromEntries(
          Object.entries(oldCols)
            .filter(([k]) => k in newCols && oldCols[k] !== newCols[k])
            .map(([k]) => [k, { from: oldCols[k], to: newCols[k] }])
        ),
      };
    }
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Breadcrumb */}
        <div className="text-sm text-gray-500">
          <Link href="/dashboard" className="hover:text-gray-300">Dashboard</Link>
          {" / "}
          <Link href={`/pipelines/${id}`} className="hover:text-gray-300">{run.pipeline_name}</Link>
          {" / "}
          <span className="text-gray-300">Run</span>
        </div>

        {/* Status banner */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-sm text-gray-400 mb-1">Status</div>
            <div className={`text-lg font-semibold capitalize ${statusColors[run.status] ?? "text-gray-300"}`}>
              {run.status.replace(/_/g, " ")}
            </div>
          </div>
          {run.file_format && (
            <div className="text-right">
              <div className="text-sm text-gray-400 mb-1">Format</div>
              <div className="text-white font-medium">{run.file_format.toUpperCase()}</div>
            </div>
          )}
          {run.row_count_raw != null && (
            <div className="text-right">
              <div className="text-sm text-gray-400 mb-1">Rows (raw)</div>
              <div className="text-white font-medium">{run.row_count_raw.toLocaleString()}</div>
            </div>
          )}
          {run.row_count_processed != null && (
            <div className="text-right">
              <div className="text-sm text-gray-400 mb-1">Rows (processed)</div>
              <div className="text-white font-medium">{run.row_count_processed.toLocaleString()}</div>
            </div>
          )}
        </div>

        {/* Quality score gauges */}
        {(rawProfile || processedProfile) && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-6">Data Quality Score</h2>
            <div className="flex items-end justify-around gap-4 flex-wrap">
              <QualityGauge score={rawProfile?.quality_score ?? null} label="Before" />

              <div className="flex flex-col items-center gap-1 pb-6">
                <div className="text-gray-600 text-2xl">→</div>
              </div>

              <QualityGauge score={processedProfile?.quality_score ?? null} label="After" />

              {delta != null && (
                <div className="flex flex-col items-center gap-1 pb-6">
                  <div className={`text-3xl font-bold ${delta >= 0 ? "text-indigo-400" : "text-red-400"}`}>
                    {delta >= 0 ? "+" : ""}{delta}
                  </div>
                  <div className="text-gray-400 text-sm">Improvement</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Column stats — raw profile */}
        {rawProfile?.column_stats && Object.keys(rawProfile.column_stats).length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Column Profile (Raw)</h2>
            <ColumnStatsTable columnStats={rawProfile.column_stats} />
          </div>
        )}

        {/* Transform rules */}
        {rules.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Transform Rules</h2>
              <div className="text-sm text-gray-400">
                {rules.filter((r) => r.status === "approved").length} approved ·{" "}
                {rules.filter((r) => r.status === "rejected").length} rejected ·{" "}
                {rules.filter((r) => r.status === "pending").length} pending
              </div>
            </div>

            {run.status === "awaiting_approval" && (
              <Link
                href={`/pipelines/${id}/runs/${rid}/review`}
                className="block w-full text-center bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-lg font-medium transition-colors mb-4"
              >
                Open Data PR →
              </Link>
            )}

            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className={`bg-gray-900 border rounded-xl p-4 ${
                    rule.status === "approved"
                      ? "border-green-500/30"
                      : rule.status === "rejected"
                      ? "border-red-500/30"
                      : "border-gray-800"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-white text-sm font-medium">
                          {rule.rule_type.replace(/_/g, " ")}
                        </span>
                        {rule.column_name && (
                          <code className="text-xs bg-gray-800 text-indigo-300 px-2 py-0.5 rounded">
                            {rule.column_name}
                          </code>
                        )}
                      </div>
                      {rule.ai_reasoning && (
                        <p className="text-gray-400 text-xs">{rule.ai_reasoning}</p>
                      )}
                    </div>
                    <span
                      className={`text-xs px-2 py-1 rounded-full font-medium flex-shrink-0 ${
                        rule.status === "approved"
                          ? "text-green-400 bg-green-400/10"
                          : rule.status === "rejected"
                          ? "text-red-400 bg-red-400/10"
                          : "text-yellow-400 bg-yellow-400/10"
                      }`}
                    >
                      {rule.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quality trend chart */}
        {trendData.length >= 2 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Quality Trend</h2>
            <QualityTrendChart data={trendData} />
          </div>
        )}

        {/* Schema drift */}
        {schemaDiff && (
          <div className="bg-gray-900 border border-yellow-500/30 rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-yellow-400 text-lg">⚠</span>
              <h2 className="text-lg font-semibold text-white">Schema Drift Detected</h2>
            </div>
            <SchemaDiffViewer diff={schemaDiff} />
          </div>
        )}

        {/* Empty/loading states */}
        {(run.status === "pending" || run.status === "profiling") && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
            <p className="text-gray-400">Profiling your data… check back in a few seconds.</p>
          </div>
        )}

        {run.status === "awaiting_ai" && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
            <p className="text-gray-400">Claude is analyzing your data…</p>
          </div>
        )}

        {run.status === "failed" && run.error_message && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
            {run.error_message}
          </div>
        )}
      </main>
    </div>
  );
}
