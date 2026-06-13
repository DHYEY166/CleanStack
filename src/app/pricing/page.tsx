import Link from "next/link";

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "For individuals exploring data quality.",
    cta: "Start for free",
    ctaHref: "/sign-up",
    highlighted: false,
    features: [
      "5 pipeline runs / month",
      "Up to 10,000 rows per run",
      "CSV, JSON, Excel formats",
      "AI quality profiling",
      "Community templates",
      "1 user",
    ],
    missing: [
      "Schema drift alerts",
      "Slack / email notifications",
      "API access",
      "Custom destinations",
      "Priority support",
    ],
  },
  {
    name: "Pro",
    price: "$49",
    period: "per month",
    description: "For growing teams with real data pipelines.",
    cta: "Start Pro trial",
    ctaHref: "/sign-up",
    highlighted: true,
    features: [
      "Unlimited pipeline runs",
      "Up to 1,000,000 rows per run",
      "All 7 formats (PDF, images, Parquet…)",
      "AI quality profiling + transform rules",
      "Full template marketplace",
      "Schema drift alerts",
      "Slack + email notifications",
      "3 users",
    ],
    missing: [
      "API access",
      "Custom destinations",
      "Priority support",
    ],
  },
  {
    name: "Team",
    price: "$149",
    period: "per month",
    description: "For data teams who run pipelines in production.",
    cta: "Contact sales",
    ctaHref: "mailto:dvdesai06@gmail.com",
    highlighted: false,
    features: [
      "Everything in Pro",
      "Unlimited rows",
      "REST API access",
      "Custom output destinations (S3, webhooks)",
      "Audit log export",
      "Schema snapshot history (90 days)",
      "10 users",
      "Priority support (4h SLA)",
      "Dedicated Slack channel",
    ],
    missing: [],
  },
];

const faqs = [
  {
    q: "What counts as a pipeline run?",
    a: "One file upload = one run. Profiling, AI suggestions, and transform execution are all included in that single run.",
  },
  {
    q: "Which AWS services does CleanStack use under the hood?",
    a: "S3 for raw and processed file storage, Lambda for profiling and transform execution, SQS for queueing, SNS for drift alerts, and Aurora PostgreSQL for all metadata. All costs are bundled into your CleanStack subscription.",
  },
  {
    q: "Can I use my own AWS account?",
    a: "Team plan customers can request a bring-your-own-cloud deployment. Contact sales for details.",
  },
  {
    q: "Is there a free trial for Pro?",
    a: "Yes — 14 days free, no credit card required.",
  },
];

function Check() {
  return <span className="text-green-400 font-bold">✓</span>;
}

function X() {
  return <span className="text-gray-700">—</span>;
}

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Nav */}
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold text-white">CleanStack</Link>
        <div className="flex items-center gap-4">
          <Link href="/templates" className="text-sm text-gray-400 hover:text-white transition-colors">Templates</Link>
          <Link href="/sign-in" className="text-sm text-gray-400 hover:text-white transition-colors">Sign in</Link>
          <Link href="/sign-up" className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors">
            Get started free
          </Link>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-20">
        {/* Header */}
        <div className="text-center mb-16">
          <h1 className="text-4xl font-bold text-white mb-4">Simple, transparent pricing</h1>
          <p className="text-gray-400 text-lg max-w-xl mx-auto">
            Under $5/month for typical SME workloads — vs $500+ for Fivetran or Talend.
            Start free, upgrade when you need more.
          </p>
        </div>

        {/* Tier cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-20">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`rounded-2xl border p-8 flex flex-col ${
                tier.highlighted
                  ? "border-indigo-500 bg-indigo-500/5 relative"
                  : "border-gray-800 bg-gray-900"
              }`}
            >
              {tier.highlighted && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="bg-indigo-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
                    Most popular
                  </span>
                </div>
              )}

              <div className="mb-6">
                <div className="text-sm font-medium text-gray-400 mb-1">{tier.name}</div>
                <div className="flex items-end gap-2 mb-2">
                  <span className="text-4xl font-bold text-white">{tier.price}</span>
                  <span className="text-gray-500 text-sm pb-1">{tier.period}</span>
                </div>
                <p className="text-gray-400 text-sm">{tier.description}</p>
              </div>

              <Link
                href={tier.ctaHref}
                className={`w-full text-center py-2.5 rounded-lg font-medium text-sm transition-colors mb-8 ${
                  tier.highlighted
                    ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                    : "border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white"
                }`}
              >
                {tier.cta}
              </Link>

              <ul className="space-y-3 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <Check />
                    <span className="text-gray-300">{f}</span>
                  </li>
                ))}
                {tier.missing.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <X />
                    <span className="text-gray-600">{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Feature comparison table */}
        <div className="mb-20">
          <h2 className="text-2xl font-bold text-white text-center mb-8">Full comparison</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-400 font-medium pb-4 pr-6 w-1/2">Feature</th>
                  {tiers.map((t) => (
                    <th key={t.name} className={`text-center pb-4 font-medium ${t.highlighted ? "text-indigo-400" : "text-gray-400"}`}>
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {[
                  ["Pipeline runs / month", "5", "Unlimited", "Unlimited"],
                  ["Max rows per run", "10,000", "1,000,000", "Unlimited"],
                  ["File formats", "CSV, JSON, Excel", "All 7 formats", "All 7 formats"],
                  ["AI quality profiling", "✓", "✓", "✓"],
                  ["AI transform suggestions", "✓", "✓", "✓"],
                  ["Data PR approval UI", "✓", "✓", "✓"],
                  ["Template marketplace", "Community", "Full access", "Full access"],
                  ["Schema drift alerts", "—", "✓", "✓"],
                  ["Slack / email alerts", "—", "✓", "✓"],
                  ["Conversational builder", "—", "✓", "✓"],
                  ["REST API access", "—", "—", "✓"],
                  ["Custom destinations", "—", "—", "✓"],
                  ["Audit log export", "—", "—", "✓"],
                  ["Users", "1", "3", "10"],
                  ["Support", "Community", "Email", "Priority (4h SLA)"],
                ].map(([feature, free, pro, team]) => (
                  <tr key={feature}>
                    <td className="py-3 pr-6 text-gray-400">{feature}</td>
                    <td className="py-3 text-center text-gray-300">{free}</td>
                    <td className="py-3 text-center text-indigo-300">{pro}</td>
                    <td className="py-3 text-center text-gray-300">{team}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto mb-20">
          <h2 className="text-2xl font-bold text-white text-center mb-8">Frequently asked questions</h2>
          <div className="space-y-6">
            {faqs.map(({ q, a }) => (
              <div key={q}>
                <div className="text-white font-medium mb-1">{q}</div>
                <div className="text-gray-400 text-sm leading-relaxed">{a}</div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA banner */}
        <div className="bg-indigo-600/10 border border-indigo-500/30 rounded-2xl p-10 text-center">
          <h2 className="text-2xl font-bold text-white mb-3">Start cleaning data today</h2>
          <p className="text-gray-400 mb-6">No credit card required. 5 free pipeline runs every month.</p>
          <Link
            href="/sign-up"
            className="inline-block bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-lg font-medium transition-colors"
          >
            Get started free →
          </Link>
        </div>
      </main>
    </div>
  );
}
