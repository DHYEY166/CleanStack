import Link from "next/link";
import Nav from "@/components/Nav";
import { query } from "@/lib/db";
import type { PipelineTemplate } from "@/lib/types";
import TemplateGrid from "./TemplateGrid";

const CATEGORIES = ["All", "CRM", "E-commerce", "Finance", "HR"];

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = category && category !== "All" ? category : null;

  const templates = await query<PipelineTemplate>(
    `SELECT * FROM pipeline_templates
     WHERE is_public = true
     ${active ? "AND category = $1" : ""}
     ORDER BY use_count DESC`,
    active ? [active] : []
  );

  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Template Marketplace</h1>
          <p className="text-gray-400">Start with a pre-built pipeline — pick a template and upload your file.</p>
        </div>

        {/* Category filter */}
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          {CATEGORIES.map((cat) => {
            const isActive = cat === "All" ? !active : active === cat;
            const href = cat === "All" ? "/templates" : `/templates?category=${cat}`;
            return (
              <Link
                key={cat}
                href={href}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white"
                }`}
              >
                {cat}
              </Link>
            );
          })}
        </div>

        {templates.length === 0 ? (
          <div className="text-center py-16 text-gray-500">No templates in this category yet.</div>
        ) : (
          <TemplateGrid templates={templates} />
        )}
      </main>
    </div>
  );
}
