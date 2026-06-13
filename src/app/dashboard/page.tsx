import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { query } from "@/lib/db";
import type { Pipeline, PipelineRun } from "@/lib/types";

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">Manage your data pipelines</p>
        </div>
        <Link
          href="/pipelines/new"
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New Pipeline
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Pipelines", value: pipelines.length },
          { label: "Active Pipelines", value: pipelines.filter((p) => p.status === "active").length },
          { label: "Recent Runs", value: recentRuns.length },
        ].map((stat) => (
          <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="text-2xl font-bold text-white">{stat.value}</div>
            <div className="text-sm text-gray-400 mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Pipelines */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-4">Pipelines</h2>
        {pipelines.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
            <p className="text-gray-400 mb-4">No pipelines yet</p>
            <Link
              href="/pipelines/new"
              className="text-indigo-400 hover:text-indigo-300 text-sm font-medium"
            >
              Create your first pipeline →
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {pipelines.map((pipeline) => (
              <Link
                key={pipeline.id}
                href={`/pipelines/${pipeline.id}`}
                className="block bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white">{pipeline.name}</div>
                    {pipeline.description && (
                      <div className="text-sm text-gray-400 mt-0.5">{pipeline.description}</div>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(pipeline.created_at).toLocaleDateString()}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent Runs */}
      {recentRuns.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-4">Recent Runs</h2>
          <div className="space-y-2">
            {recentRuns.map((run) => (
              <Link
                key={run.id}
                href={`/pipelines/${run.pipeline_id}/runs/${run.id}`}
                className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-colors"
              >
                <div>
                  <span className="text-white text-sm font-medium">{run.pipeline_name}</span>
                  <span className="text-gray-500 text-xs ml-2">
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded-full font-medium ${
                    statusColors[run.status] ?? "text-gray-400 bg-gray-400/10"
                  }`}
                >
                  {run.status.replace(/_/g, " ")}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
