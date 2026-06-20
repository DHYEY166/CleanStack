import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import {
  Plus,
  Database,
  Activity,
  Zap,
  FileText,
  Rows3,
  CheckCircle2,
  XCircle,
  Clock,
  Loader,
  ArrowRight,
  Workflow,
} from "lucide-react";
import { query } from "@/lib/db";
import type { Pipeline, PipelineRun } from "@/lib/types";
import DeletePipelineButton from "@/components/DeletePipelineButton";
import UsageMeter from "@/components/UsageMeter";

async function getPipelines(teamId: string): Promise<Pipeline[]> {
  try {
    return await query<Pipeline>(
      "SELECT * FROM pipelines WHERE team_id = $1 AND status != 'archived' ORDER BY created_at DESC",
      [teamId]
    );
  } catch {
    return [];
  }
}

async function getRecentRuns(teamId: string): Promise<(PipelineRun & { pipeline_name: string })[]> {
  try {
    return await query<PipelineRun & { pipeline_name: string }>(
      `SELECT pr.*, p.name AS pipeline_name
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE p.team_id = $1
       ORDER BY pr.created_at DESC
       LIMIT 5`,
      [teamId]
    );
  } catch {
    return [];
  }
}

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
      return <Loader className={className} aria-hidden="true" />;
    case "pending":
    case "queued":
    case "awaiting_ai":
    case "awaiting_approval":
      return <Clock className={className} aria-hidden="true" />;
    default:
      return <Clock className={className} aria-hidden="true" />;
  }
}

export default async function DashboardPage() {
  const { userId } = await auth();
  const teamId = userId!;

  const [pipelines, recentRuns] = await Promise.all([
    getPipelines(teamId),
    getRecentRuns(teamId),
  ]);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">Manage your data pipelines</p>
        </div>
        <Link
          href="/pipelines/new"
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white pl-3 pr-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm shadow-indigo-600/20"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Pipeline
        </Link>
      </div>

      {/* Usage meter */}
      <UsageMeter />

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            label: "Total Pipelines",
            value: pipelines.length,
            icon: Database,
            accent: "border-l-indigo-500",
            iconColor: "text-indigo-400 bg-indigo-400/10",
          },
          {
            label: "Active Pipelines",
            value: pipelines.filter((p) => p.status === "active").length,
            icon: Zap,
            accent: "border-l-green-500",
            iconColor: "text-green-400 bg-green-400/10",
          },
          {
            label: "Recent Runs",
            value: recentRuns.length,
            icon: Activity,
            accent: "border-l-blue-500",
            iconColor: "text-blue-400 bg-blue-400/10",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className={`bg-gray-900 border border-gray-800 border-l-2 ${stat.accent} rounded-xl p-5 flex items-center justify-between gap-4 hover:border-gray-700 transition-colors`}
          >
            <div>
              <div className="text-3xl font-bold tracking-tight text-white">{stat.value}</div>
              <div className="text-sm text-gray-400 mt-1">{stat.label}</div>
            </div>
            <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${stat.iconColor}`}>
              <stat.icon className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>
        ))}
      </div>

      {/* Pipelines */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Pipelines</h2>
          {pipelines.length > 0 && (
            <span className="text-xs text-gray-500">{pipelines.length} total</span>
          )}
        </div>
        {pipelines.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center flex flex-col items-center">
            <div className="h-12 w-12 rounded-xl bg-indigo-500/10 flex items-center justify-center mb-4">
              <Workflow className="h-6 w-6 text-indigo-400" aria-hidden="true" />
            </div>
            <h3 className="text-white font-medium">No pipelines yet</h3>
            <p className="text-gray-400 text-sm mt-1 mb-5 max-w-sm">
              Create your first pipeline to start profiling, cleaning, and transforming your data
              automatically.
            </p>
            <Link
              href="/pipelines/new"
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white pl-3 pr-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create your first pipeline
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {pipelines.map((pipeline) => (
              <div
                key={pipeline.id}
                className="group bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-colors flex items-center justify-between gap-4"
              >
                <Link href={`/pipelines/${pipeline.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="h-9 w-9 flex-shrink-0 rounded-lg bg-gray-800 flex items-center justify-center text-gray-400 group-hover:text-indigo-400 transition-colors">
                    <Workflow className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white truncate">{pipeline.name}</span>
                      <span
                        className={`hidden sm:inline-flex text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-medium ${
                          statusColors[pipeline.status] ?? "text-gray-400 bg-gray-400/10"
                        }`}
                      >
                        {pipeline.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    {pipeline.description && (
                      <div className="text-sm text-gray-400 mt-0.5 truncate">{pipeline.description}</div>
                    )}
                  </div>
                </Link>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-xs text-gray-500 hidden sm:flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {new Date(pipeline.created_at).toLocaleDateString()}
                  </div>
                  <DeletePipelineButton
                    pipelineId={pipeline.id}
                    pipelineName={pipeline.name}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Runs */}
      {recentRuns.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-4">Recent Runs</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800 overflow-hidden">
            {recentRuns.map((run) => {
              const badgeColor = statusColors[run.status] ?? "text-gray-400 bg-gray-400/10";
              return (
                <Link
                  key={run.id}
                  href={`/pipelines/${run.pipeline_id}/runs/${run.id}`}
                  className="group flex items-center gap-4 p-4 hover:bg-gray-800/40 transition-colors"
                >
                  <div className={`h-8 w-8 flex-shrink-0 rounded-full flex items-center justify-center ${badgeColor}`}>
                    <StatusIcon status={run.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white text-sm font-medium truncate">{run.pipeline_name}</span>
                      {run.file_format && (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">
                          <FileText className="h-3 w-3" aria-hidden="true" />
                          {run.file_format}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
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
                  <span
                    className={`hidden sm:inline-flex items-center text-xs px-2 py-1 rounded-full font-medium ${badgeColor}`}
                  >
                    {run.status.replace(/_/g, " ")}
                  </span>
                  <ArrowRight
                    className="h-4 w-4 text-gray-600 group-hover:text-gray-400 transition-colors flex-shrink-0"
                    aria-hidden="true"
                  />
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
