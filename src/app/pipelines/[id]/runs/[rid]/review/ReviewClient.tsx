"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/Nav";
import PRHeader from "@/components/DataPR/PRHeader";
import RuleCard, { type RuleDecision } from "@/components/DataPR/RuleCard";
import type { PipelineRun, TransformRule } from "@/lib/types";

interface ReviewClientProps {
  pipelineId: string;
  run: PipelineRun & { pipeline_name: string };
  rules: TransformRule[];
}

export default function ReviewClient({ pipelineId, run, rules }: ReviewClientProps) {
  const router = useRouter();
  const [decisions, setDecisions] = useState<Map<string, RuleDecision>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDecision = useCallback((d: RuleDecision) => {
    setDecisions((prev) => new Map(prev).set(d.rule_id, d));
  }, []);

  function approveAll() {
    setDecisions(new Map(rules.map((r) => [r.id, { rule_id: r.id, action: "approved" as const, modifications: null }])));
  }
  function rejectAll() {
    setDecisions(new Map(rules.map((r) => [r.id, { rule_id: r.id, action: "rejected" as const, modifications: null }])));
  }

  const approved = [...decisions.values()].filter((d) => d.action === "approved").length;
  const rejected = [...decisions.values()].filter((d) => d.action === "rejected").length;

  async function submitReview() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/approve-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: run.id,
          rule_decisions: [...decisions.values()],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Submit failed");
      }
      router.push(`/pipelines/${pipelineId}/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-3xl mx-auto px-6 py-8 space-y-4">
        {/* Breadcrumb */}
        <div className="text-sm text-gray-500">
          <Link href="/dashboard" className="hover:text-gray-300">Dashboard</Link>
          {" / "}
          <Link href={`/pipelines/${pipelineId}`} className="hover:text-gray-300">
            {run.pipeline_name}
          </Link>
          {" / "}
          <Link href={`/pipelines/${pipelineId}/runs/${run.id}`} className="hover:text-gray-300">
            Run
          </Link>
          {" / "}
          <span className="text-gray-300">Review</span>
        </div>

        <PRHeader
          pipelineName={run.pipeline_name}
          runId={run.id}
          total={rules.length}
          approved={approved}
          rejected={rejected}
          submitting={submitting}
          onSubmit={submitReview}
        />

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
            {error}
          </div>
        )}

        {rules.length > 1 && (
          <div className="flex gap-2">
            <button
              onClick={approveAll}
              className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              ✓ Approve All
            </button>
            <button
              onClick={rejectAll}
              className="px-4 py-2 bg-red-900 hover:bg-red-800 text-white text-sm font-medium rounded-lg transition-colors"
            >
              ✗ Reject All
            </button>
          </div>
        )}

        <div className="space-y-2">
          {rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} onChange={handleDecision} />
          ))}
        </div>

        {rules.length === 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-400">
            No pending rules found.
          </div>
        )}
      </main>
    </div>
  );
}
