import Link from "next/link";
import {
  FileStack,
  ScanSearch,
  GitPullRequestArrow,
  Gauge,
  Zap,
  BellRing,
  MessagesSquare,
  Package,
  ArrowRight,
  Check,
  ShieldCheck,
  Clock,
  DollarSign,
} from "lucide-react";

const features = [
  {
    icon: FileStack,
    title: "Multi-format Ingestion",
    description: "CSV, Excel, PDF, scanned invoices, JSON, XML, Parquet — upload anything, 50 MB limit.",
  },
  {
    icon: ScanSearch,
    title: "AI Data Profiling",
    description: "Claude analyzes nulls, duplicates, type mismatches, and outliers. Quality score in seconds.",
  },
  {
    icon: GitPullRequestArrow,
    title: "Data PR Workflow",
    description: "Review AI-suggested transforms like a GitHub PR. Approve, reject, or edit. Full audit trail.",
  },
  {
    icon: Gauge,
    title: "Quality Score Gauges",
    description: "Animated 0–100 score before and after. Visual proof your data improved — shareable with stakeholders.",
  },
  {
    icon: Zap,
    title: "Serverless Execution",
    description: "AWS Lambda runs transforms. $49/month vs $500+ for Fivetran — same result, 10x cheaper.",
  },
  {
    icon: BellRing,
    title: "Schema Drift Alerts",
    description: "Column renamed or removed in a new batch? Slack fires within 30 seconds before your pipeline breaks.",
  },
  {
    icon: MessagesSquare,
    title: "Conversational Builder",
    description: "Describe your data in plain English. Claude configures the pipeline — no YAML, no clicks.",
  },
  {
    icon: Package,
    title: "Template Marketplace",
    description: "HubSpot CRM, Shopify Orders, Finance Reports — start with a battle-tested rule set.",
  },
];

const steps = [
  { n: "01", title: "Upload", desc: "Drop any file. S3 stores it, Lambda profiles it." },
  { n: "02", title: "Review", desc: "Claude suggests 5–8 transform rules. Approve like a PR." },
  { n: "03", title: "Execute", desc: "Lambda applies rules, writes clean file, scores improve." },
  { n: "04", title: "Alert", desc: "Schema changes in next batch? Slack fires automatically." },
];

const stats = [
  { icon: DollarSign, value: "$49", label: "Pro plan vs $500+/mo Fivetran" },
  { icon: Clock, value: "2 min", label: "raw file to clean data" },
  { icon: ShieldCheck, value: "100%", label: "auditable transforms" },
];

const builtFor = ["Finance & Accounting", "E-commerce", "HR & Recruiting", "CRM & Sales", "Healthcare", "AI / ML Teams"];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-gray-800/80 bg-gray-950/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <span className="flex items-center gap-2 text-xl font-bold text-white tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <GitPullRequestArrow className="h-4 w-4" />
            </span>
            CleanStack
          </span>
          <div className="flex items-center gap-6">
            <Link href="/templates" className="hidden sm:block text-sm text-gray-400 hover:text-white transition-colors">
              Templates
            </Link>
            <Link href="/pricing" className="hidden sm:block text-sm text-gray-400 hover:text-white transition-colors">
              Pricing
            </Link>
            <Link href="/sign-in" className="text-sm text-gray-400 hover:text-white transition-colors">
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              Get started free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,rgba(99,102,241,0.18),transparent)]"
        />
        <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
          <div className="inline-flex items-center gap-2 mb-6 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-sm font-medium">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
            </span>
            B2B Data Pipeline Automation · Built on Vercel + AWS Aurora
          </div>
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-white mb-6 leading-[1.05] text-balance">
            Raw data in.
            <br />
            <span className="text-indigo-400">Clean data out.</span>
          </h1>
          <p className="text-lg sm:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed text-pretty">
            Upload any data file, get AI-powered cleaning suggestions, approve them like a GitHub
            PR, and watch your quality score jump — all without writing a line of code.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link
              href="/sign-up"
              className="group inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-lg font-medium transition-colors"
            >
              Start for free
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/pricing"
              className="border border-gray-700 hover:border-gray-500 hover:bg-gray-900 text-gray-300 px-8 py-3 rounded-lg font-medium transition-colors"
            >
              See pricing
            </Link>
          </div>
          <p className="mt-6 flex items-center justify-center gap-2 text-xs text-gray-500">
            <Check className="h-3.5 w-3.5 text-emerald-400" />
            No credit card required · Free tier forever
          </p>
        </div>
      </section>

      {/* Demo score banner */}
      <section className="max-w-2xl mx-auto px-6 mb-20">
        <div className="rounded-2xl border border-gray-800 bg-gradient-to-b from-gray-900 to-gray-900/40 p-6 sm:p-8 shadow-2xl shadow-indigo-950/30">
          <p className="text-xs uppercase tracking-wider text-gray-500 text-center mb-6">
            Quality score · customer_orders.csv · 405 rows
          </p>
          <div className="flex items-center justify-between flex-wrap gap-6">
            <div className="text-center flex-1 min-w-[80px]">
              <div className="text-5xl font-bold text-red-400">68</div>
              <div className="text-sm text-gray-500 mt-1">Before</div>
            </div>
            <div className="flex flex-col items-center gap-1 text-gray-400">
              <ArrowRight className="h-6 w-6 text-indigo-400" />
              <div className="text-xs text-indigo-400 font-medium whitespace-nowrap">Data PR approved</div>
            </div>
            <div className="text-center flex-1 min-w-[80px]">
              <div className="text-5xl font-bold text-emerald-400">88</div>
              <div className="text-sm text-gray-500 mt-1">After</div>
            </div>
            <div className="text-center flex-1 min-w-[80px]">
              <div className="text-2xl font-bold text-indigo-400">+20</div>
              <div className="text-sm text-gray-500 mt-1">Improvement</div>
            </div>
          </div>
        </div>
      </section>

      {/* Built for */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <p className="text-center text-xs uppercase tracking-wider text-gray-600 mb-6">
          Built for data teams in
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
          {builtFor.map((name) => (
            <span key={name} className="text-lg font-semibold text-gray-600 hover:text-gray-400 transition-colors">
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* Stats */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.label}
                className="flex items-center gap-4 rounded-xl border border-gray-800 bg-gray-900/50 p-5"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <div className="text-2xl font-bold text-white">{s.value}</div>
                  <div className="text-sm text-gray-500">{s.label}</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white tracking-tight">How it works</h2>
          <p className="text-gray-400 mt-2">From messy upload to clean, audited data in four steps.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {steps.map((s) => (
            <div
              key={s.n}
              className="relative rounded-xl border border-gray-800 bg-gray-900/40 p-5"
            >
              <div className="text-3xl font-bold text-indigo-500/50 mb-3">{s.n}</div>
              <div className="text-white font-semibold mb-1">{s.title}</div>
              <div className="text-gray-400 text-sm leading-relaxed">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features grid */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white tracking-tight text-balance">
            Everything your data team needs
          </h2>
          <p className="text-gray-400 mt-2">One platform from ingestion to alerting — no glue code.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="group rounded-xl border border-gray-800 bg-gray-900/50 p-5 transition-colors hover:border-indigo-500/40 hover:bg-gray-900"
              >
                <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 transition-colors group-hover:bg-indigo-500/20">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="font-semibold text-white mb-1.5 text-sm">{feature.title}</h3>
                <p className="text-xs text-gray-400 leading-relaxed">{feature.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Templates teaser */}
      <section className="border-t border-gray-800 py-20">
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex items-end justify-between mb-8 flex-wrap gap-4">
            <div>
              <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Start with a template</h2>
              <p className="text-gray-400 text-sm">Pre-built rule sets for the most common data sources.</p>
            </div>
            <Link
              href="/templates"
              className="inline-flex items-center gap-1 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Browse all templates
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { name: "HubSpot CRM Cleaner", cat: "CRM", uses: 142, color: "text-blue-400 bg-blue-400/10" },
              { name: "E-commerce Orders", cat: "E-commerce", uses: 98, color: "text-emerald-400 bg-emerald-400/10" },
              { name: "Finance Report Normalizer", cat: "Finance", uses: 76, color: "text-yellow-400 bg-yellow-400/10" },
              { name: "HR Roster Cleaner", cat: "HR", uses: 54, color: "text-purple-400 bg-purple-400/10" },
            ].map((t) => (
              <Link
                key={t.name}
                href="/templates"
                className="group rounded-xl border border-gray-800 bg-gray-900/50 p-4 transition-colors hover:border-gray-700 hover:bg-gray-900"
              >
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.color}`}>{t.cat}</span>
                <div className="text-white text-sm font-medium mt-3 mb-1 group-hover:text-indigo-300 transition-colors">
                  {t.name}
                </div>
                <div className="text-gray-500 text-xs">{t.uses} uses</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-gray-800 py-24">
        <div className="max-w-3xl mx-auto px-6">
          <div className="relative overflow-hidden rounded-2xl border border-indigo-500/30 bg-gradient-to-b from-indigo-600/15 to-gray-900/20 p-10 text-center">
            <h2 className="text-3xl font-bold text-white tracking-tight text-balance">
              Ship clean data this afternoon
            </h2>
            <p className="text-gray-400 mt-3 max-w-xl mx-auto text-pretty">
              Free tier available · Pro from{" "}
              <span className="text-white font-medium">$49/month</span>. No credit card to start.
            </p>
            <div className="mt-8 flex items-center justify-center gap-4 flex-wrap">
              <Link
                href="/sign-up"
                className="group inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-lg font-medium transition-colors"
              >
                Start for free
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/pricing"
                className="border border-gray-700 hover:border-gray-500 hover:bg-gray-900 text-gray-300 px-8 py-3 rounded-lg font-medium transition-colors"
              >
                See full pricing
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-white">
              <GitPullRequestArrow className="h-3.5 w-3.5" />
            </span>
            CleanStack
          </span>
          <div className="flex items-center gap-6 text-sm text-gray-400">
            <Link href="/templates" className="hover:text-white transition-colors">Templates</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
            <Link href="/sign-in" className="hover:text-white transition-colors">Sign in</Link>
          </div>
          <p className="text-xs text-gray-600">© {new Date().getFullYear()} CleanStack. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
