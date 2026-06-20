import Link from "next/link";
import {
  Users,
  ShoppingCart,
  TrendingUp,
  Briefcase,
  LayoutGrid,
  PackageSearch,
  type LucideIcon,
} from "lucide-react";
import Nav from "@/components/Nav";
import { query } from "@/lib/db";
import type { PipelineTemplate } from "@/lib/types";
import TemplateGrid from "./TemplateGrid";

const CATEGORIES = ["All", "CRM", "E-commerce", "Finance", "HR"];

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  All: LayoutGrid,
  CRM: Users,
  "E-commerce": ShoppingCart,
  Finance: TrendingUp,
  HR: Briefcase,
};

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
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight text-white">Template Marketplace</h1>
            <span className="inline-flex items-center text-xs font-medium text-indigo-300 bg-indigo-500/10 border border-indigo-500/30 rounded-full px-2.5 py-1">
              {templates.length} {templates.length === 1 ? "template" : "templates"} available
            </span>
          </div>
          <p className="text-gray-400 leading-relaxed">Start with a pre-built pipeline — pick a template and upload your file.</p>
        </div>

        {/* Category filter */}
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          {CATEGORIES.map((cat) => {
            const isActive = cat === "All" ? !active : active === cat;
            const href = cat === "All" ? "/templates" : `/templates?category=${cat}`;
            const Icon = CATEGORY_ICONS[cat] ?? LayoutGrid;
            return (
              <Link
                key={cat}
                href={href}
                className={`inline-flex items-center gap-1.5 pl-3 pr-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {cat}
              </Link>
            );
          })}
        </div>

        {templates.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-xl bg-gray-800 flex items-center justify-center mb-4">
              <PackageSearch className="h-6 w-6 text-gray-500" aria-hidden="true" />
            </div>
            <h3 className="text-white font-medium">No templates here yet</h3>
            <p className="text-gray-400 text-sm mt-1 max-w-sm">
              We haven&apos;t published any templates in this category yet. Try another category or browse all
              templates.
            </p>
            <Link
              href="/templates"
              className="inline-flex items-center gap-1.5 mt-5 text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
              Browse all templates
            </Link>
          </div>
        ) : (
          <TemplateGrid templates={templates} />
        )}
      </main>
    </div>
  );
}
