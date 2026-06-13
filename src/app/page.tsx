import Link from "next/link";

const features = [
  {
    title: "Multi-format Ingestion",
    description: "CSV, Excel, PDF, scanned invoices, JSON, XML, Parquet — upload anything.",
  },
  {
    title: "AI Data Profiling",
    description: "Claude analyzes your data and surfaces nulls, duplicates, type mismatches, and outliers instantly.",
  },
  {
    title: "Data PR Workflow",
    description: "Review AI-suggested transforms like a GitHub PR. Approve, reject, or edit each rule. Full audit trail.",
  },
  {
    title: "Quality Score",
    description: "See a 0–100 quality score before and after cleaning. Visual proof your data improved.",
  },
  {
    title: "Serverless Execution",
    description: "AWS Lambda runs your transforms. Under $5/month for SME workloads vs $500+ for Fivetran.",
  },
  {
    title: "Schema Drift Alerts",
    description: "Detects column changes in new batches and fires Slack or email alerts before your pipeline breaks.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Nav */}
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto">
        <span className="text-xl font-bold text-white">CleanStack</span>
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm text-gray-400 hover:text-white transition-colors">
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors"
          >
            Get started free
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
        <div className="inline-block mb-4 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-400 text-sm">
          B2B Data Pipeline Automation
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
        <div className="flex items-center justify-center gap-4">
          <Link
            href="/sign-up"
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-lg font-medium transition-colors"
          >
            Start for free
          </Link>
          <Link
            href="/sign-in"
            className="border border-gray-700 hover:border-gray-500 text-gray-300 px-8 py-3 rounded-lg font-medium transition-colors"
          >
            Sign in
          </Link>
        </div>
      </section>

      {/* Demo score banner */}
      <section className="max-w-2xl mx-auto px-6 mb-20">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex items-center justify-between">
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
            <div className="text-sm text-gray-500 mt-1">Quality score</div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold text-white text-center mb-12">
          Everything your data team needs
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-indigo-500/40 transition-colors"
            >
              <h3 className="font-semibold text-white mb-2">{feature.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="border-t border-gray-800 py-16 text-center">
        <p className="text-gray-400 text-sm">
          Free tier available · Pro from{" "}
          <span className="text-white font-medium">$49/month</span> · No credit card required to start
        </p>
      </section>
    </div>
  );
}
