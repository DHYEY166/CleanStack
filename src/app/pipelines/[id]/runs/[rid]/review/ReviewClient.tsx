"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  CheckCheck,
  XCircle,
  ListChecks,
  AlertCircle,
  ClipboardCheck,
} from "lucide-react";
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
      <main className="max-w-3xl mx-auto px-6 py-8 pb-24 space-y-4">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-gray-500">
          <Link href="/dashboard" className="hover:text-gray-300 transition-colors">Dashboard</Link>
          <ChevronRight className="h-3.5 w-3.5 text-gray-700" aria-hidden="true" />
          <Link href={`/pipelines/${pipelineId}`} className="hover:text-gray-300 transition-colors truncate max-w-[200px]">
            {run.pipeline_name}
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-gray-700" aria-hidden="true" />
          <Link href={`/pipelines/${pipelineId}/runs/${run.id}`} className="hover:text-gray-300 transition-colors">
            Run
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-gray-700" aria-hidden="true" />
          <span className="text-gray-300 font-medium">Review</span>
        </nav>

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
          <div className="flex items-start gap-2.5 bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Rules list header with count + bulk actions */}
        {rules.length > 0 && (
          <div className="flex items-center justify-between gap-4 flex-wrap pt-2">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <ListChecks className="h-4 w-4 text-indigo-400" aria-hidden="true" />
              {rules.length} {rules.length === 1 ? "rule" : "rules"} to review
            </div>
            {rules.length > 1 && (
              <div className="flex gap-2">
                <button
                  onClick={approveAll}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-green-500/40 text-green-400 hover:bg-green-500/10 hover:border-green-500/60 text-sm font-medium rounded-lg transition-colors"
                >
                  <CheckCheck className="h-4 w-4" aria-hidden="true" />
                  Approve all
                </button>
                <button
                  onClick={rejectAll}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 text-sm font-medium rounded-lg transition-colors"
                >
                  <XCircle className="h-4 w-4" aria-hidden="true" />
                  Reject all
                </button>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          {rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} onChange={handleDecision} />
          ))}
        </div>

        {rules.length === 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-xl bg-gray-800 flex items-center justify-center mb-4">
              <ClipboardCheck className="h-6 w-6 text-gray-500" aria-hidden="true" />
            </div>
            <h3 className="text-white font-medium">Nothing to review</h3>
            <p className="text-gray-400 text-sm mt-1">There are no pending rules for this run.</p>
          </div>
        )}
      </main>

      {/* Sticky tally bar */}
      {rules.length > 0 && (
        <div className="sticky bottom-0 z-40 border-t border-gray-800 bg-gray-950/90 backdrop-blur-md">
          <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-center gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" aria-hidden="true" />
              {approved} approved
            </span>
            <span className="text-gray-700" aria-hidden="true">·</span>
            <span className="flex items-center gap-1.5 text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" aria-hidden="true" />
              {rejected} rejected
            </span>
            <span className="text-gray-700" aria-hidden="true">·</span>
            <span className="flex items-center gap-1.5 text-gray-400">
              <span className="h-1.5 w-1.5 rounded-full bg-gray-500" aria-hidden="true" />
              {rules.length - approved - rejected} pending
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
