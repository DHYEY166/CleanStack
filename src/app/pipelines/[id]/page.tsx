import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  Plus,
  FileText,
  Rows3,
  CheckCircle2,
  XCircle,
  Clock,
  Loader,
  ArrowRight,
  Workflow,
  Layers,
} from "lucide-react";
import Nav from "@/components/Nav";
import { query, queryOne } from "@/lib/db";
import type { Pipeline, PipelineRun } from "@/lib/types";

const statusColors: Record<string, string> = {
  pending: "text-yellow-400 bg-yellow-400/10",
  profiling: "text-blue-400 bg-blue-400/10",
  awaiting_ai: "text-purple-400 bg-purple-400/10",
  awaiting_approval: "text-orange-400 bg-orange-400/10",
  queued: "text-yellow-400 bg-yellow-400/10",
  running: "text-blue-400 bg-blue-400/10",
  completed: "text-green-400 bg-green-400/10",
  failed: "text-red-400 bg-red-400/10",
};

function relativeTime(dateString: string): string {
  const then = new Date(dateString).getTime();
  const diffMs = Date.now() - then;
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(dateString).toLocaleDateString();
}

function StatusIcon({ status }: { status: string }) {
  const className = "h-3.5 w-3.5";
  switch (status) {
    case "completed":
      return <CheckCircle2 className={className} aria-hidden="true" />;
    case "failed":
      return <XCircle className={className} aria-hidden="true" />;
    case "running":
    case "profiling":
    case "queued":
      return <Loader className={className} aria-hidden="true" />;
    case "pending":
    case "awaiting_ai":
    case "awaiting_approval":
      return <Clock className={className} aria-hidden="true" />;
    default:
      return <Clock className={className} aria-hidden="true" />;
  }
}

export default async function PipelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await auth();
  const { id } = await params;

  const pipeline = await queryOne<Pipeline>(
    "SELECT * FROM pipelines WHERE id = $1 AND team_id = $2",
    [id, userId]
  );
  if (!pipeline) notFound();

  const runs = await query<PipelineRun>(
    "SELECT * FROM pipeline_runs WHERE pipeline_id = $1 ORDER BY created_at DESC LIMIT 20",
    [id]
  );

  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* Header */}
        <div className="space-y-4">
          {/* Breadcrumb */}
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-gray-500">
            <Link href="/dashboard" className="hover:text-gray-300 transition-colors">Dashboard</Link>
            <ChevronRight className="h-3.5 w-3.5 text-gray-700" aria-hidden="true" />
            <span className="text-gray-300 font-medium truncate max-w-[260px]">{pipeline.name}</span>
          </nav>

          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3 min-w-0">
              <div className="h-11 w-11 flex-shrink-0 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                <Workflow className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-white text-balance">{pipeline.name}</h1>
                {pipeline.description && (
                  <p className="text-gray-400 text-sm mt-1 leading-relaxed text-pretty">{pipeline.description}</p>
                )}
              </div>
            </div>
            <Link
              href="/pipelines/new"
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white pl-3 pr-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm shadow-indigo-600/20 flex-shrink-0"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New Run
            </Link>
          </div>
        </div>

        {/* Run history */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Run History</h2>
            {runs.length > 0 && (
              <span className="text-xs text-gray-500">{runs.length} {runs.length === 1 ? "run" : "runs"}</span>
            )}
          </div>
          {runs.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center flex flex-col items-center">
              <div className="h-12 w-12 rounded-xl bg-indigo-500/10 flex items-center justify-center mb-4">
                <Workflow className="h-6 w-6 text-indigo-400" aria-hidden="true" />
              </div>
              <h3 className="text-white font-medium">No runs yet</h3>
              <p className="text-gray-400 text-sm mt-1 mb-5 max-w-sm">
                Upload a file to kick off your first run — CleanStack will profile, clean, and transform your
                data automatically.
              </p>
              <Link
                href="/pipelines/new"
                className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white pl-3 pr-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Start your first run
              </Link>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800 overflow-hidden">
              {runs.map((run) => {
                const badgeColor = statusColors[run.status] ?? "text-gray-400 bg-gray-400/10";
                return (
                  <Link
                    key={run.id}
                    href={`/pipelines/${id}/runs/${run.id}`}
                    className="group flex items-center gap-4 p-4 hover:bg-gray-800/40 transition-colors"
                  >
                    <div className={`h-8 w-8 flex-shrink-0 rounded-full flex items-center justify-center ${badgeColor}`}>
                      <StatusIcon status={run.status} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium capitalize ${badgeColor}`}
                        >
                          {run.status.replace(/_/g, " ")}
                        </span>
                        {run.file_format && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-gray-300 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded">
                            <FileText className="h-3 w-3" aria-hidden="true" />
                            {run.file_format}
                          </span>
                        )}
                        {run.iteration > 1 && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-indigo-300 bg-indigo-500/10 px-1.5 py-0.5 rounded-full font-medium">
                            <Layers className="h-3 w-3" aria-hidden="true" />
                            Pass {run.iteration}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {relativeTime(run.created_at)}
                        </span>
                        {run.row_count_raw != null && (
                          <span className="flex items-center gap-1">
                            <Rows3 className="h-3 w-3" aria-hidden="true" />
                            {run.row_count_raw.toLocaleString()} rows
                          </span>
                        )}
                      </div>
                    </div>
                    <ArrowRight
                      className="h-4 w-4 text-gray-600 group-hover:text-gray-400 group-hover:translate-x-0.5 transition-all flex-shrink-0"
                      aria-hidden="true"
                    />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
