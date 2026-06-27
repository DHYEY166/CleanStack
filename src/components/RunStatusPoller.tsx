"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const TERMINAL = new Set(["completed", "failed", "awaiting_approval"]);
const BACKOFF_MS = [3000, 5000, 8000, 12000, 20000, 30000];

export default function RunStatusPoller({
  runId,
  currentStatus,
  pipelineId,
}: {
  runId: string;
  currentStatus: string;
  pipelineId?: string;
}) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const statusRef = useRef(currentStatus);
  const attemptRef = useRef(0);

  useEffect(() => {
    if (TERMINAL.has(currentStatus)) return;

    let timeoutId: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/run-status/${runId}`);
        if (!res.ok) { schedule(); return; }
        const { run, child_run_id } = await res.json();
        if (!run) { schedule(); return; }

        if (run.status !== statusRef.current) {
          statusRef.current = run.status;
          attemptRef.current = 0; // reset backoff on state change — next poll should be fast

          if (run.status === "completed" && child_run_id && pipelineId) {
            routerRef.current.push(`/pipelines/${pipelineId}/runs/${child_run_id}`);
            return;
          }

          routerRef.current.refresh();
        }

        if (TERMINAL.has(run.status)) return;
        attemptRef.current++;
        schedule();
      } catch {
        schedule();
      }
    }

    function schedule() {
      const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)];
      timeoutId = setTimeout(poll, delay);
    }

    schedule();
    return () => clearTimeout(timeoutId);
  // router excluded from deps — stable ref via routerRef prevents stale closure + multiple poll loops
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, currentStatus, pipelineId]);

  return null;
}
