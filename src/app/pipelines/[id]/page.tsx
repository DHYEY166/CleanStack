import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
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
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm text-gray-500 mb-1">
              <Link href="/dashboard" className="hover:text-gray-300">Dashboard</Link>
              {" / "}
              <span className="text-gray-300">{pipeline.name}</span>
            </div>
            <h1 className="text-2xl font-bold text-white">{pipeline.name}</h1>
            {pipeline.description && (
              <p className="text-gray-400 text-sm mt-1">{pipeline.description}</p>
            )}
          </div>
          <Link
            href="/pipelines/new"
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            + New Run
          </Link>
        </div>

        {/* Run history */}
        <div>
          <h2 className="text-lg font-semibold text-white mb-4">Run History</h2>
          {runs.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-10 text-center text-gray-400">
              No runs yet. Upload a file to get started.
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <Link
                  key={run.id}
                  href={`/pipelines/${id}/runs/${run.id}`}
                  className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <span
                      className={`text-xs px-2 py-1 rounded-full font-medium ${
                        statusColors[run.status] ?? "text-gray-400 bg-gray-400/10"
                      }`}
                    >
                      {run.status.replace(/_/g, " ")}
                    </span>
                    <span className="text-gray-400 text-sm">
                      {run.file_format?.toUpperCase() ?? "—"}
                    </span>
                    {run.row_count_raw != null && (
                      <span className="text-gray-500 text-xs">
                        {run.row_count_raw.toLocaleString()} rows
                      </span>
                    )}
                  </div>
                  <span className="text-gray-500 text-xs">
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
