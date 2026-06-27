import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  GitPullRequest,
  Loader2,
  AlertTriangle,
  AlertCircle,
  Gauge,
  Table2,
  ListChecks,
  TrendingUp,
  FileText,
} from "lucide-react";
import Nav from "@/components/Nav";
import { queryOne, query } from "@/lib/db";
import type { PipelineRun, DataProfile, TransformRule } from "@/lib/types";
import QualityGauge from "@/components/QualityGauge";
import ColumnStatsTable from "@/components/ColumnStatsTable";
import QualityTrendChart from "@/components/QualityTrendChart";
import SchemaDiffViewer from "@/components/SchemaDiffViewer";
import DownloadButton from "@/components/DownloadButton";
import RunStatusPoller from "@/components/RunStatusPoller";
import DocumentProfile from "@/components/DocumentProfile";
import TrainingExport from "@/components/TrainingExport";
import IterationBanner from "@/components/IterationBanner";
import AutoCleanSummary from "@/components/AutoCleanSummary";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; rid: string }>;
}) {
  const { userId } = await auth();
  const { id, rid } = await params;

  const run = await queryOne<PipelineRun & { pipeline_name: string; mode: string }>(
    `SELECT pr.*, p.name AS pipeline_name
     FROM pipeline_runs pr
     JOIN pipelines p ON pr.pipeline_id = p.id
     WHERE pr.id = $1 AND p.team_id = $2`,
    [rid, userId]
  );
  if (!run) notFound();

  const [rawProfile, processedProfile, rules, trendRuns, schemaDriftData, parentProcessedProfile, autoChainRuns] = await Promise.all([
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
    // Fetch parent run's processed score for % improvement calculation
    run.parent_run_id
      ? queryOne<DataProfile>(
          "SELECT * FROM data_profiles WHERE run_id = $1 AND stage = 'processed'",
          [run.parent_run_id]
        )
      : Promise.resolve(null),
    // Fetch all auto-clean sibling runs for summary (walk chain)
    run.auto_mode
      ? query<{ id: string; iteration: number; processed_score: number | null; parent_run_id: string | null }>(
          `WITH RECURSIVE chain AS (
             SELECT id, iteration, parent_run_id FROM pipeline_runs WHERE id = $1
             UNION ALL
             SELECT pr.id, pr.iteration, pr.parent_run_id
             FROM pipeline_runs pr JOIN chain c ON pr.id = c.parent_run_id
           )
           SELECT ch.id, ch.iteration, ch.parent_run_id, dp.quality_score AS processed_score
           FROM chain ch
           LEFT JOIN data_profiles dp ON dp.run_id = ch.id AND dp.stage = 'processed'
           WHERE ch.iteration > 1
           ORDER BY ch.iteration ASC`,
          [rid]
        )
      : Promise.resolve([]),
  ]);

  const canDownload = run.status === "completed" && !!run.processed_s3_key;

  // % improvement = (this_pass_processed - parent_processed) / parent_processed * 100
  const iterationImprovement =
    canDownload &&
    run.parent_run_id &&
    processedProfile?.quality_score != null &&
    parentProcessedProfile?.quality_score != null &&
    Number(parentProcessedProfile.quality_score) > 0
      ? Math.round(
          ((Number(processedProfile.quality_score) - Number(parentProcessedProfile.quality_score)) /
            Number(parentProcessedProfile.quality_score)) *
            100 *
            10
        ) / 10
      : null;

  // Build auto-clean summary passes (fetch rules per pass)
  type PassRule = { id: string; rule_type: string; column_name: string | null; status: string; ai_reasoning: string | null; parameters: Record<string, unknown> | null };
  const autoSummaryPasses: Array<{ iteration: number; improvement: number | null; processedScore: number | null; rules: PassRule[] }> = [];
  if (run.auto_mode && autoChainRuns.length > 0) {
    const passRulesArr = await Promise.all(
      autoChainRuns.map((cr) =>
        query<PassRule>(
          "SELECT id, rule_type, column_name, status, ai_reasoning, parameters FROM transform_rules WHERE run_id = $1 ORDER BY order_index ASC",
          [cr.id]
        )
      )
    );
    for (let i = 0; i < autoChainRuns.length; i++) {
      const cr = autoChainRuns[i];
      const prevScore = i === 0
        ? (parentProcessedProfile?.quality_score ?? null)
        : (autoChainRuns[i - 1].processed_score ?? null);
      const imp = cr.processed_score != null && prevScore != null && Number(prevScore) > 0
        ? Math.round(((Number(cr.processed_score) - Number(prevScore)) / Number(prevScore)) * 100 * 10) / 10
        : null;
      autoSummaryPasses.push({ iteration: cr.iteration, improvement: imp, processedScore: cr.processed_score ?? null, rules: passRulesArr[i] });
    }
  }

  const trendData = trendRuns
    .filter((r) => r.quality_score != null)
    .map((r, i) => ({
      run_index: i + 1,
      score: Number(r.quality_score!),
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
      ? Number(processedProfile.quality_score) - Number(rawProfile.quality_score)
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
      <RunStatusPoller runId={rid} currentStatus={run.status} pipelineId={id} />
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-gray-500">
          <Link href="/dashboard" className="hover:text-gray-300 transition-colors">Dashboard</Link>
          <ChevronRight className="h-3.5 w-3.5 text-gray-700" aria-hidden="true" />
          <Link href={`/pipelines/${id}`} className="hover:text-gray-300 transition-colors truncate max-w-[200px]">{run.pipeline_name}</Link>
          <ChevronRight className="h-3.5 w-3.5 text-gray-700" aria-hidden="true" />
          <span className="text-gray-300 font-medium">Run</span>
        </nav>

        {/* Status banner */}
        <div className={`bg-gray-900 border border-gray-800 border-l-2 rounded-xl p-6 flex items-center gap-6 flex-wrap ${statusColors[run.status] ?? "text-gray-500"}`} style={{ borderLeftColor: "currentColor" }}>
          <div>
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-1.5">Status</div>
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-semibold capitalize px-2.5 py-1 rounded-full bg-current/10 ${
                statusColors[run.status] ?? "text-gray-300"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
              {run.status.replace(/_/g, " ")}
            </span>
          </div>

          <div className="flex items-center gap-6 flex-wrap">
            {run.file_format && (
              <div>
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-1.5">Format</div>
                <div className="text-white font-medium tabular-nums">{run.file_format.toUpperCase()}</div>
              </div>
            )}
            {run.row_count_raw != null && (
              <div>
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-1.5">{run.mode === "document" ? "Lines (raw)" : "Rows (raw)"}</div>
                <div className="text-white font-medium tabular-nums">{run.row_count_raw.toLocaleString()}</div>
              </div>
            )}
            {run.row_count_processed != null && (
              <div>
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-1.5">{run.mode === "document" ? "Lines (processed)" : "Rows (processed)"}</div>
                <div className="text-white font-medium tabular-nums">{run.row_count_processed.toLocaleString()}</div>
              </div>
            )}
          </div>

          {canDownload && (
            <div className="ml-auto">
              <DownloadButton
                runId={rid}
                inputFormat={run.file_format ?? "csv"}
                mode={run.mode ?? "tabular"}
              />
            </div>
          )}
        </div>

        {/* AI Training Export — tabular completed runs only */}
        {canDownload && run.mode !== "document" && (
          <TrainingExport runId={rid} />
        )}

        {/* Multi-pass iteration banner — show on all completed runs */}
        {canDownload && (
          <IterationBanner
            runId={rid}
            pipelineId={id}
            iteration={run.iteration ?? 1}
            improvement={iterationImprovement}
            processedScore={processedProfile?.quality_score != null ? Number(processedProfile.quality_score) : null}
            autoMode={run.auto_mode ?? false}
          />
        )}

        {/* Auto-clean summary panel */}
        {canDownload && run.auto_mode && autoSummaryPasses.length > 0 && (
          <AutoCleanSummary passes={autoSummaryPasses} />
        )}

        {/* Quality score gauges */}
        {(rawProfile || processedProfile) && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white mb-6">
              <Gauge className="h-5 w-5 text-indigo-400" aria-hidden="true" />
              Data Quality Score
            </h2>
            <div className="flex items-end justify-around gap-4 flex-wrap">
              <QualityGauge score={rawProfile?.quality_score != null ? Number(rawProfile.quality_score) : null} label="Before" />

              <div className="flex flex-col items-center gap-1 pb-6">
                <div className="text-gray-600 text-2xl">→</div>
              </div>

              <QualityGauge score={processedProfile?.quality_score != null ? Number(processedProfile.quality_score) : null} label="After" />

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

        {/* Profile section — document vs tabular */}
        {rawProfile && run.mode === "document" ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white mb-4">
              <FileText className="h-5 w-5 text-indigo-400" aria-hidden="true" />
              Document Profile
            </h2>
            <DocumentProfile
              qualityScore={rawProfile.quality_score != null ? Number(rawProfile.quality_score) : 0}
              totalLines={rawProfile.total_rows ?? 0}
              columnStats={rawProfile.column_stats ?? {}}
            />
          </div>
        ) : (
          rawProfile?.column_stats && Object.keys(rawProfile.column_stats).length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white mb-4">
                <Table2 className="h-5 w-5 text-indigo-400" aria-hidden="true" />
                Column Profile (Raw)
              </h2>
              <ColumnStatsTable columnStats={rawProfile.column_stats} />
            </div>
          )
        )}

        {/* Transform rules */}
        {rules.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <ListChecks className="h-5 w-5 text-indigo-400" aria-hidden="true" />
                Transform Rules
              </h2>
              <div className="text-sm text-gray-400">
                <span className="text-green-400">{rules.filter((r) => r.status === "approved").length} approved</span> ·{" "}
                <span className="text-red-400">{rules.filter((r) => r.status === "rejected").length} rejected</span> ·{" "}
                <span className="text-yellow-400">{rules.filter((r) => r.status === "pending").length} pending</span>
              </div>
            </div>

            {run.status === "awaiting_approval" && (
              <Link
                href={`/pipelines/${id}/runs/${rid}/review`}
                className="group flex w-full items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white py-3 rounded-lg font-medium transition-all shadow-lg shadow-indigo-900/30 mb-4"
              >
                <GitPullRequest className="h-4 w-4" aria-hidden="true" />
                Open Data PR
                <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
              </Link>
            )}

            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className={`bg-gray-900 border border-l-2 rounded-xl p-4 ${
                    rule.status === "approved"
                      ? "border-gray-800 border-l-green-500"
                      : rule.status === "rejected"
                      ? "border-gray-800 border-l-red-500"
                      : "border-gray-800 border-l-yellow-500"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <code className="text-xs font-mono bg-gray-800 text-gray-200 px-2 py-0.5 rounded border border-gray-700">
                          {rule.rule_type.replace(/_/g, " ")}
                        </code>
                        {rule.column_name && (
                          <code className="text-xs bg-gray-800 text-indigo-300 px-2 py-0.5 rounded">
                            {rule.column_name}
                          </code>
                        )}
                      </div>
                      {rule.ai_reasoning && (
                        <p className="text-gray-400 text-sm leading-relaxed">{rule.ai_reasoning}</p>
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
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white mb-4">
              <TrendingUp className="h-5 w-5 text-indigo-400" aria-hidden="true" />
              Quality Trend
            </h2>
            <QualityTrendChart data={trendData} />
          </div>
        )}

        {/* Schema drift */}
        {schemaDiff && (
          <div className="bg-gray-900 border border-yellow-500/30 rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="h-5 w-5 text-yellow-400" aria-hidden="true" />
              <h2 className="text-lg font-semibold text-white">Schema Drift Detected</h2>
            </div>
            <SchemaDiffViewer diff={schemaDiff} />
          </div>
        )}

        {/* Empty/loading states */}
        {(run.status === "pending" || run.status === "profiling") && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 flex flex-col items-center text-center">
            <Loader2 className="h-7 w-7 text-indigo-400 animate-spin mb-4" aria-hidden="true" />
            <p className="text-white font-medium">Profiling your data</p>
            <p className="text-gray-400 text-sm mt-1">Analyzing structure and quality — this updates automatically in a few seconds.</p>
          </div>
        )}

        {run.status === "awaiting_ai" && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 flex flex-col items-center text-center">
            <Loader2 className="h-7 w-7 text-indigo-400 animate-spin mb-4" aria-hidden="true" />
            <p className="text-white font-medium">Claude is analyzing your data</p>
            <p className="text-gray-400 text-sm mt-1">Generating transform suggestions — this page will refresh on its own.</p>
          </div>
        )}

        {run.status === "failed" && run.error_message && (
          <div className="flex items-start gap-2.5 bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{run.error_message}</span>
          </div>
        )}
      </main>
    </div>
  );
}
