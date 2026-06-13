import Link from "next/link";

const features = [
  {
    icon: "📂",
    title: "Multi-format Ingestion",
    description: "CSV, Excel, PDF, scanned invoices, JSON, XML, Parquet — upload anything, 50 MB limit.",
  },
  {
    icon: "🔍",
    title: "AI Data Profiling",
    description: "Claude analyzes nulls, duplicates, type mismatches, and outliers. Quality score in seconds.",
  },
  {
    icon: "✅",
    title: "Data PR Workflow",
    description: "Review AI-suggested transforms like a GitHub PR. Approve, reject, or edit. Full audit trail.",
  },
  {
    icon: "📈",
    title: "Quality Score Gauges",
    description: "Animated 0–100 score before and after. Visual proof your data improved — shareable with stakeholders.",
  },
  {
    icon: "⚡",
    title: "Serverless Execution",
    description: "AWS Lambda runs transforms. Under $5/month for SME workloads vs $500+ for Fivetran.",
  },
  {
    icon: "🔔",
    title: "Schema Drift Alerts",
    description: "Column renamed or removed in a new batch? Slack fires within 30 seconds before your pipeline breaks.",
  },
  {
    icon: "💬",
    title: "Conversational Builder",
    description: "Describe your data in plain English. Claude configures the pipeline — no YAML, no clicks.",
  },
  {
    icon: "📦",
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

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Nav */}
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto">
        <span className="text-xl font-bold text-white">CleanStack</span>
        <div className="flex items-center gap-6">
          <Link href="/templates" className="text-sm text-gray-400 hover:text-white transition-colors">Templates</Link>
          <Link href="/pricing" className="text-sm text-gray-400 hover:text-white transition-colors">Pricing</Link>
          <Link href="/sign-in" className="text-sm text-gray-400 hover:text-white transition-colors">Sign in</Link>
          <Link
            href="/sign-up"
            className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors"
          >
            Get started free
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
        <div className="inline-block mb-4 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-400 text-sm font-medium">
          B2B Data Pipeline Automation · Built on Vercel + AWS Aurora
        </div>
        <h1 className="text-5xl font-bold tracking-tight text-white mb-6 leading-tight">
          Raw data in.
          <br />
          <span className="text-indigo-400">Clean data out.</span>
        </h1>
        <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Upload any data file, get AI-powered cleaning suggestions, approve them
          like a GitHub PR, and watch your quality score jump — all for under $5/month.
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link
            href="/sign-up"
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-lg font-medium transition-colors"
          >
            Start for free →
          </Link>
          <Link
            href="/pricing"
            className="border border-gray-700 hover:border-gray-500 text-gray-300 px-8 py-3 rounded-lg font-medium transition-colors"
          >
            See pricing
          </Link>
        </div>
      </section>

      {/* Demo score banner */}
      <section className="max-w-2xl mx-auto px-6 mb-20">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex items-center justify-between flex-wrap gap-4">
          <div className="text-center">
            <div className="text-5xl font-bold text-red-400">42</div>
            <div className="text-sm text-gray-500 mt-1">Before</div>
          </div>
          <div className="flex flex-col items-center gap-1 text-gray-400">
            <div className="text-2xl">→</div>
            <div className="text-xs text-indigo-400 font-medium">Data PR approved</div>
          </div>
          <div className="text-center">
            <div className="text-5xl font-bold text-green-400">91</div>
            <div className="text-sm text-gray-500 mt-1">After</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-indigo-400">+49</div>
            <div className="text-sm text-gray-500 mt-1">Improvement</div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold text-white text-center mb-12">How it works</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {steps.map((s) => (
            <div key={s.n} className="text-center">
              <div className="text-3xl font-bold text-indigo-500/40 mb-3">{s.n}</div>
              <div className="text-white font-semibold mb-1">{s.title}</div>
              <div className="text-gray-400 text-sm leading-relaxed">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features grid */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold text-white text-center mb-12">
          Everything your data team needs
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-indigo-500/40 transition-colors"
            >
              <div className="text-2xl mb-3">{feature.icon}</div>
              <h3 className="font-semibold text-white mb-1.5 text-sm">{feature.title}</h3>
              <p className="text-xs text-gray-400 leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Templates teaser */}
      <section className="border-t border-gray-800 py-20">
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex items-end justify-between mb-8 flex-wrap gap-4">
            <div>
              <h2 className="text-2xl font-bold text-white mb-1">Start with a template</h2>
              <p className="text-gray-400 text-sm">Pre-built rule sets for the most common data sources.</p>
            </div>
            <Link href="/templates" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
              Browse all templates →
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
                className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors"
              >
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.color}`}>{t.cat}</span>
                <div className="text-white text-sm font-medium mt-2 mb-1">{t.name}</div>
                <div className="text-gray-500 text-xs">{t.uses} uses</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="border-t border-gray-800 py-16">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <p className="text-gray-400 text-sm mb-1">
            Free tier available · Pro from{" "}
            <span className="text-white font-medium">$49/month</span>
          </p>
          <Link href="/pricing" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            See full pricing →
          </Link>
        </div>
      </section>
    </div>
  );
}
