import { describe, expect, it } from "vitest";
import { ConfigError, ENV_SPEC, awsRegion, checkEnv, optionalEnv, requireEnv } from "@/lib/env";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const valid = {
  AURORA_CLUSTER_ARN: "arn:aws:rds:us-east-1:000000000000:cluster:example",
  AURORA_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:example",
  S3_RAW_BUCKET: "raw-bucket",
  S3_PROCESSED_BUCKET: "processed-bucket",
  SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/000000000000/jobs",
  NEXT_PUBLIC_APP_URL: "https://example.com",
  WEBHOOK_SECRET: "x".repeat(32),
  CRON_SECRET: "y".repeat(32),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CLERK_SECRET_KEY: "sk_test_x",
  UPSTASH_REDIS_REST_URL: "https://redis.example.com",
  UPSTASH_REDIS_REST_TOKEN: "t",
};

describe("requireEnv", () => {
  it("returns a valid value (trimmed)", () => {
    expect(requireEnv("S3_RAW_BUCKET", valid)).toBe("raw-bucket");
    expect(requireEnv("S3_RAW_BUCKET", { S3_RAW_BUCKET: " b \n" })).toBe("b");
  });
  it("names the variable when it is missing or blank", () => {
    expect(() => requireEnv("S3_RAW_BUCKET", {})).toThrow(new ConfigError("Configuration error: S3_RAW_BUCKET is not set"));
    expect(() => requireEnv("S3_RAW_BUCKET", { S3_RAW_BUCKET: "  " })).toThrow(/S3_RAW_BUCKET is not set/);
  });
  it("rejects malformed values with the reason", () => {
    expect(() => requireEnv("AURORA_CLUSTER_ARN", { AURORA_CLUSTER_ARN: "cluster-1" })).toThrow(/must be an AWS ARN/);
    expect(() => requireEnv("SQS_QUEUE_URL", { SQS_QUEUE_URL: "queue" })).toThrow(/must be a URL/);
  });
  it("does not reject existing short secrets at call sites (only warns at startup)", () => {
    expect(requireEnv("WEBHOOK_SECRET", { WEBHOOK_SECRET: "short" })).toBe("short");
  });
});

describe("optionalEnv / awsRegion", () => {
  it("returns undefined for unset variables", () => expect(optionalEnv("AI_JOBS_QUEUE_URL", {})).toBeUndefined());
  it("validates variables when set", () =>
    expect(() => optionalEnv("AI_JOBS_QUEUE_URL", { AI_JOBS_QUEUE_URL: "not a url" })).toThrow(ConfigError));
  it("defaults the region", () => {
    expect(awsRegion({})).toBe("us-east-1");
    expect(optionalEnv("AWS_REGION", {})).toBe("us-east-1");
    expect(awsRegion({ AWS_REGION: "eu-west-1" })).toBe("eu-west-1");
  });
});

describe("checkEnv", () => {
  it("is clean for a complete configuration", () => expect(checkEnv(valid)).toEqual({ errors: [], warnings: [] }));
  it("lists missing required variables and weak secrets", () => {
    const r = checkEnv({ ...valid, S3_RAW_BUCKET: undefined, ADMIN_SECRET: "short" });
    expect(r.errors).toEqual(["S3_RAW_BUCKET is not set"]);
    expect(r.warnings).toEqual(["ADMIN_SECRET is shorter than 32 characters"]);
  });
  it("flags cross-variable problems", () => {
    expect(checkEnv({ ...valid, AI_QUEUE_ENABLED: "true" }).errors).toContain(
      "AI_JOBS_QUEUE_URL is not set but AI_QUEUE_ENABLED=true");
    expect(checkEnv({ ...valid, UPSTASH_REDIS_REST_TOKEN: undefined }).warnings[0]).toMatch(/must be set together/);
  });
});

describe(".env.example", () => {
  it("documents every variable in ENV_SPEC", () => {
    const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    for (const name of Object.keys(ENV_SPEC)) expect(example, name).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
  });
});
