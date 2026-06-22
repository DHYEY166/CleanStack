import Link from "next/link";
import {
  Check as CheckIcon,
  Minus,
  GitPullRequestArrow,
  ArrowRight,
  Sparkles,
} from "lucide-react";

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "For individuals exploring data quality.",
    cta: "Start for free",
    ctaHref: "/sign-up",
    highlighted: false,
    included: "50,000 rows / month included",
    overage: null,
    features: [
      "50,000 rows / month (hard cap)",
      "5 pipeline runs / month",
      "CSV, JSON, Excel formats",
      "AI quality profiling",
      "Community templates",
      "1 user",
    ],
    missing: [
      "Row overage",
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
    cta: "Start for free",
    ctaHref: "/sign-up",
    highlighted: true,
    included: "1,000,000 rows / month included",
    overage: "$0.50 per 100K rows after that",
    features: [
      "1,000,000 rows / month included",
      "$0.50 per 100K rows overage",
      "Unlimited pipeline runs",
      "All 7 formats (PDF, DOCX, Parquet…)",
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
    price: "$199",
    period: "per month",
    description: "For data teams running GB-scale pipelines in production.",
    cta: "Contact sales",
    ctaHref: "/sign-up",
    highlighted: false,
    included: "10,000,000 rows / month included",
    overage: "$0.30 per 100K rows after that",
    features: [
      "10,000,000 rows / month included",
      "$0.30 per 100K rows overage",
      "Unlimited pipeline runs",
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
    q: "How does row-based billing work?",
    a: "Each plan includes a monthly row quota. Rows are counted from the raw input file per pipeline run. If you stay within your quota, you pay only the base fee. If you exceed it, overage is charged at the per-100K rate shown on your plan.",
  },
  {
    q: "What counts as a pipeline run?",
    a: "One file upload = one run. Profiling, AI suggestions, transform execution, and all auto-clean passes are included in the row count for that run.",
  },
  {
    q: "Will I get a surprise bill?",
    a: "Free plan has a hard row cap — no overage, no surprises. Pro and Team plans show a real-time usage meter in your dashboard so you always know where you stand.",
  },
  {
    q: "Which AWS services does CleanStack use under the hood?",
    a: "S3 for raw and processed file storage, Lambda for profiling and transform execution, SQS for queueing, SNS for drift alerts, and Aurora PostgreSQL for all metadata. All infrastructure costs are bundled into your CleanStack subscription.",
  },
  {
    q: "Can I use my own AWS account?",
    a: "Team plan customers can request a bring-your-own-cloud deployment. Contact sales for details.",
  },
  {
    q: "Is there a free tier?",
    a: "Yes — the Free plan gives you 50,000 rows/month at no cost, forever. No credit card required. Upgrade to Pro when you need more.",
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
      <nav className="sticky top-0 z-50 border-b border-gray-800/80 bg-gray-950/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-xl font-bold text-white tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <GitPullRequestArrow className="h-4 w-4" />
            </span>
            CleanStack
          </Link>
          <div className="flex items-center gap-6">
            <Link href="/templates" className="hidden sm:block text-sm text-gray-400 hover:text-white transition-colors">Templates</Link>
            <Link href="/sign-in" className="text-sm text-gray-400 hover:text-white transition-colors">Sign in</Link>
            <Link href="/sign-up" className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium transition-colors">
              Get started free
            </Link>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-20">
        {/* Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 mb-6 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-sm font-medium">
            <Sparkles className="h-3.5 w-3.5" />
            Transparent, usage-based pricing
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white mb-4 text-balance">Simple, transparent pricing</h1>
          <p className="text-gray-400 text-lg max-w-xl mx-auto leading-relaxed text-pretty">
            Under $5/month for typical SME workloads — vs $500+ for Fivetran or Talend.
            Start free, upgrade when you need more.
          </p>
        </div>

        {/* Tier cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-20 items-start">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-2xl border flex flex-col transition-colors ${
                tier.highlighted
                  ? "border-indigo-500 bg-indigo-500/[0.07] shadow-2xl shadow-indigo-950/40 md:-mt-4 md:mb-4"
                  : "border-gray-800 bg-gray-900/60 hover:border-gray-700"
              }`}
            >
              {tier.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1 bg-indigo-600 text-white text-xs font-semibold px-3 py-1 rounded-full shadow-lg shadow-indigo-600/30">
                    <Sparkles className="h-3 w-3" />
                    Most popular
                  </span>
                </div>
              )}

              <div className="p-8 pb-0">
                <div className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">{tier.name}</div>
                <div className="flex items-end gap-2 mb-3">
                  <span className="text-4xl font-bold tracking-tight text-white">{tier.price}</span>
                  <span className="text-gray-500 text-sm pb-1">{tier.period}</span>
                </div>
                <p className="text-gray-400 text-sm leading-relaxed min-h-[40px]">{tier.description}</p>
              </div>

              <div className="px-8 pt-5">
                {tier.overage && (
                  <div className="rounded-lg border border-gray-700/80 bg-gray-800/50 px-3 py-2.5">
                    <p className="text-xs font-semibold text-gray-200">{tier.included}</p>
                    <p className="text-xs text-gray-500 mt-1 pt-1 border-t border-gray-700/60">{tier.overage}</p>
                  </div>
                )}
                {!tier.overage && tier.included && (
                  <div className="rounded-lg border border-gray-700/80 bg-gray-800/50 px-3 py-2.5">
                    <p className="text-xs font-semibold text-gray-200">{tier.included}</p>
                    <p className="text-xs text-gray-500 mt-1 pt-1 border-t border-gray-700/60">Hard cap — no surprise bills</p>
                  </div>
                )}
              </div>

              <div className="px-8 pt-6">
                <Link
                  href={tier.ctaHref}
                  className={`block w-full text-center py-2.5 rounded-lg font-medium text-sm transition-colors ${
                    tier.highlighted
                      ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-600/20"
                      : "border border-gray-700 hover:border-gray-500 bg-gray-800/40 text-gray-200 hover:text-white"
                  }`}
                >
                  {tier.cta}
                </Link>
              </div>

              <div className="px-8 pt-7 pb-8 mt-6 border-t border-gray-800/80">
                <ul className="space-y-3">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <CheckIcon className="h-4 w-4 mt-0.5 flex-shrink-0 text-green-400" aria-hidden="true" />
                      <span className="text-gray-300">{f}</span>
                    </li>
                  ))}
                  {tier.missing.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <Minus className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-700" aria-hidden="true" />
                      <span className="text-gray-600">{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>

        {/* Feature comparison table */}
        <div className="mb-20">
          <h2 className="text-2xl font-bold tracking-tight text-white text-center mb-8">Full comparison</h2>
          <div className="overflow-x-auto rounded-2xl border border-gray-800">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-[57px] z-10">
                <tr className="bg-gray-900/95 backdrop-blur-sm">
                  <th className="text-left text-gray-300 font-semibold py-4 px-5 w-2/5 border-b border-gray-800">Feature</th>
                  {tiers.map((t) => (
                    <th
                      key={t.name}
                      className={`text-center py-4 px-4 font-semibold border-b border-gray-800 ${
                        t.highlighted ? "text-indigo-400 bg-indigo-500/[0.06]" : "text-gray-300"
                      }`}
                    >
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["Included rows / month", "50,000", "1,000,000", "10,000,000"],
                  ["Overage rate", "Not available", "$0.50 / 100K rows", "$0.30 / 100K rows"],
                  ["Pipeline runs / month", "5", "Unlimited", "Unlimited"],
                  ["File formats", "CSV, JSON, Excel", "All 7 formats", "All 7 formats"],
                  ["AI quality profiling", "✓", "✓", "✓"],
                  ["AI transform suggestions", "✓", "✓", "✓"],
                  ["Multi-pass auto-clean", "✓", "✓", "✓"],
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
                ].map(([feature, free, pro, team], i) => {
                  const renderCell = (value: string) => {
                    if (value === "✓")
                      return <CheckIcon className="h-4 w-4 mx-auto text-green-400" aria-label="Included" />;
                    if (value === "—")
                      return <Minus className="h-4 w-4 mx-auto text-gray-700" aria-label="Not included" />;
                    return value;
                  };
                  return (
                    <tr key={feature} className={i % 2 === 1 ? "bg-gray-900/40" : ""}>
                      <td className="py-3 px-5 text-gray-300 font-medium">{feature}</td>
                      <td className="py-3 px-4 text-center text-gray-400">{renderCell(free)}</td>
                      <td className="py-3 px-4 text-center text-indigo-200 bg-indigo-500/[0.04]">{renderCell(pro)}</td>
                      <td className="py-3 px-4 text-center text-gray-400">{renderCell(team)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto mb-20">
          <h2 className="text-2xl font-bold tracking-tight text-white text-center mb-8">Frequently asked questions</h2>
          <div className="space-y-3">
            {faqs.map(({ q, a }) => (
              <div
                key={q}
                className="rounded-xl border border-gray-800 bg-gray-900/50 p-5 transition-colors hover:border-gray-700"
              >
                <div className="text-white font-semibold mb-2">{q}</div>
                <div className="text-gray-400 text-sm leading-relaxed">{a}</div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA banner */}
        <div className="relative overflow-hidden rounded-2xl border border-indigo-500/30 bg-gradient-to-b from-indigo-600/15 to-gray-900/20 p-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white mb-3 text-balance">Start cleaning data today</h2>
          <p className="text-gray-400 mb-8 text-pretty">No credit card required. 5 free pipeline runs every month.</p>
          <Link
            href="/sign-up"
            className="group inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-lg font-medium transition-colors"
          >
            Get started free
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </main>
    </div>
  );
}
