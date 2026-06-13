"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function UseTemplateButton({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUse() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/use`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed");
      router.push(`/pipelines/${data.pipeline_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleUse}
        disabled={loading}
        className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium text-sm transition-colors"
      >
        {loading ? "Creating pipeline…" : "Use Template →"}
      </button>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
