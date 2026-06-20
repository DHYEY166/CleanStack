import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight, TrendingUp, Database, ListChecks } from "lucide-react";
import Nav from "@/components/Nav";
import { queryOne } from "@/lib/db";
import type { PipelineTemplate } from "@/lib/types";
import UseTemplateButton from "./UseTemplateButton";

const CATEGORY_COLORS: Record<string, string> = {
  CRM: "text-blue-400 bg-blue-400/10",
  "E-commerce": "text-emerald-400 bg-emerald-400/10",
  Finance: "text-yellow-400 bg-yellow-400/10",
  HR: "text-purple-400 bg-purple-400/10",
};

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const template = await queryOne<PipelineTemplate>(
    "SELECT * FROM pipeline_templates WHERE id = $1 AND is_public = true",
    [id]
  );
  if (!template) notFound();

  const rules = Array.isArray(template.transform_rules) ? template.transform_rules : [];

  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-3xl mx-auto px-6 py-10 space-y-6">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-gray-500">
          <Link href="/templates" className="hover:text-gray-300 transition-colors">Templates</Link>
          <ChevronRight className="h-3.5 w-3.5 text-gray-700" aria-hidden="true" />
          <span className="text-gray-300 font-medium truncate max-w-[260px]">{template.name}</span>
        </nav>

        {/* Header */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                {template.category && (
                  <span className={`text-xs px-2.5 py-1 rounded-full font-semibold uppercase tracking-wide ${CATEGORY_COLORS[template.category] ?? "text-gray-400 bg-gray-800"}`}>
                    {template.category}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400">
                  <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                  {template.use_count.toLocaleString()} uses
                </span>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-white text-balance">{template.name}</h1>
            </div>
            <UseTemplateButton templateId={template.id} />
          </div>

          {template.description && (
            <p className="text-gray-400 leading-relaxed text-pretty">{template.description}</p>
          )}
        </div>

        {/* Sample input schema */}
        {template.sample_input_schema && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
              <Database className="h-4 w-4 text-indigo-400" aria-hidden="true" />
              Expected Input Schema
            </h2>
            <div className="flex flex-wrap gap-2">
              {Object.entries(template.sample_input_schema).map(([col, type]) => (
                <div key={col} className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-3 py-1.5">
                  <code className="text-indigo-300 text-xs">{col}</code>
                  <span className="text-gray-600 text-xs">·</span>
                  <span className="text-gray-500 text-xs">{String(type)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Rules */}
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white mb-3">
            <ListChecks className="h-5 w-5 text-indigo-400" aria-hidden="true" />
            Transform Rules <span className="text-gray-500 text-sm font-normal">({rules.length})</span>
          </h2>
          <div className="space-y-2">
            {rules.map((rule, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-gray-800 text-xs font-mono font-medium text-gray-400 tabular-nums">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono bg-gray-800 text-gray-200 px-2 py-0.5 rounded border border-gray-700">
                        {rule.rule_type.replace(/_/g, " ")}
                      </code>
                      {rule.column_name && (
                        <code className="text-xs bg-gray-800 text-indigo-300 px-2 py-0.5 rounded">
                          {rule.column_name}
                        </code>
                      )}
                      {rule.parameters && Object.keys(rule.parameters).length > 0 && (
                        <span className="text-xs text-gray-500">
                          {Object.entries(rule.parameters)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(", ")}
                        </span>
                      )}
                    </div>
                    {rule.ai_reasoning && (
                      <p className="text-gray-400 text-sm leading-relaxed mt-1.5">{rule.ai_reasoning}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
