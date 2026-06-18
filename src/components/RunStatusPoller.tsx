"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const TERMINAL = new Set(["completed", "failed", "awaiting_approval"]);
const POLL_MS = 3000;

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
  const statusRef = useRef(currentStatus);

  useEffect(() => {
    if (TERMINAL.has(currentStatus)) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/run-status/${runId}`);
        if (!res.ok) return;
        const { run, child_run_id } = await res.json();
        if (!run) return;

        if (run.status !== statusRef.current) {
          statusRef.current = run.status;

          if (run.status === "completed" && child_run_id && pipelineId) {
            // Executor auto-iterated — jump to the next pass immediately
            clearInterval(interval);
            router.push(`/pipelines/${pipelineId}/runs/${child_run_id}`);
            return;
          }

          router.refresh();
        }

        if (TERMINAL.has(run.status)) {
          clearInterval(interval);
        }
      } catch {
        // network blip — keep polling
      }
    }, POLL_MS);

    return () => clearInterval(interval);
  }, [runId, currentStatus, pipelineId, router]);

  return null;
}
