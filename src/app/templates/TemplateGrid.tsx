"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { PipelineTemplate } from "@/lib/types";

const CATEGORY_COLORS: Record<string, string> = {
  CRM: "text-blue-400 bg-blue-400/10",
  "E-commerce": "text-emerald-400 bg-emerald-400/10",
  Finance: "text-yellow-400 bg-yellow-400/10",
  HR: "text-purple-400 bg-purple-400/10",
};

function UseButton({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleUse() {
    setLoading(true);
    try {
      const res = await fetch(`/api/templates/${templateId}/use`, { method: "POST" });
      const data = await res.json();
      if (data.pipeline_id) {
        router.push(`/pipelines/${data.pipeline_id}`);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleUse}
      disabled={loading}
      className="w-full mt-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium transition-colors"
    >
      {loading ? "Creating…" : "Use Template →"}
    </button>
  );
}

export default function TemplateGrid({ templates }: { templates: PipelineTemplate[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((t) => (
        <div
          key={t.id}
          className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col hover:border-gray-700 transition-colors"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <Link
              href={`/templates/${t.id}`}
              className="text-white font-semibold hover:text-indigo-300 transition-colors leading-snug"
            >
              {t.name}
            </Link>
            {t.category && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${CATEGORY_COLORS[t.category] ?? "text-gray-400 bg-gray-800"}`}>
                {t.category}
              </span>
            )}
          </div>

          {t.description && (
            <p className="text-gray-400 text-sm leading-relaxed flex-1 mb-3">
              {t.description}
            </p>
          )}

          <div className="flex items-center justify-between text-xs text-gray-500 mt-auto">
            <span>{t.transform_rules?.length ?? 0} rules</span>
            <span>{t.use_count.toLocaleString()} uses</span>
          </div>

          <UseButton templateId={t.id} />
        </div>
      ))}
    </div>
  );
}
