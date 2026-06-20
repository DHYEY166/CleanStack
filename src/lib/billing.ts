import { queryOne } from "@/lib/db";

export const PLANS = {
  free: { name: "Free",  includedRows: 50_000,      overagePer100k: null, hardCap: true  },
  pro:  { name: "Pro",   includedRows: 1_000_000,   overagePer100k: 0.5,  hardCap: false },
  team: { name: "Team",  includedRows: 10_000_000,  overagePer100k: 0.3,  hardCap: false },
} as const;

export type PlanId = keyof typeof PLANS;

export interface Subscription {
  id: string;
  team_id: string;
  plan: PlanId;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuotaResult {
  plan: PlanId | "admin";
  includedRows: number;
  used: number;
  remaining: number;
  hardCap: boolean;
  blocked: boolean;
  isAdmin: boolean;
}

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

export function isAdmin(email: string | null | undefined, userId?: string | null): boolean {
  if (userId && ADMIN_USER_IDS.has(userId)) return true;
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

export async function getSubscription(teamId: string): Promise<Subscription | null> {
  return queryOne<Subscription>(
    "SELECT * FROM subscriptions WHERE team_id = $1",
    [teamId]
  );
}

function periodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getMonthlyUsage(teamId: string): Promise<number> {
  const result = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(pr.row_count_raw), 0) AS total
     FROM pipeline_runs pr
     JOIN pipelines p ON pr.pipeline_id = p.id
     WHERE p.team_id = $1
       AND pr.iteration = 1
       AND pr.created_at >= $2`,
    [teamId, periodStart()]
  );
  return Number(result?.total ?? 0);
}

export async function checkQuota(
  teamId: string,
  email?: string | null,
  userId?: string | null
): Promise<QuotaResult> {
  if (isAdmin(email, userId)) {
    return {
      plan: "admin",
      includedRows: Infinity,
      used: 0,
      remaining: Infinity,
      hardCap: false,
      blocked: false,
      isAdmin: true,
    };
  }

  const sub = await getSubscription(teamId);
  const planId: PlanId = (sub?.plan as PlanId) ?? "free";
  const planConfig = PLANS[planId];

  const used = await getMonthlyUsage(teamId);
  const remaining = Math.max(0, planConfig.includedRows - used);
  const blocked = planConfig.hardCap && used >= planConfig.includedRows;

  return {
    plan: planId,
    includedRows: planConfig.includedRows,
    used,
    remaining,
    hardCap: planConfig.hardCap,
    blocked,
    isAdmin: false,
  };
}
