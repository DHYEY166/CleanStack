import { describe, expect, it } from "vitest";
import { hostedPlatformMarker, isTestMode } from "@/lib/test-mode";
import { checkEnv } from "@/lib/env";

describe("isTestMode", () => {
  it("is off unless CLEANSTACK_TEST_MODE is exactly 1", () => {
    expect(isTestMode({})).toBe(false);
    expect(isTestMode({ CLEANSTACK_TEST_MODE: "true" })).toBe(false);
    expect(isTestMode({ CLEANSTACK_TEST_MODE: "0" })).toBe(false);
    expect(isTestMode({ CLEANSTACK_TEST_MODE: "1" })).toBe(true);
  });

  it.each(["VERCEL", "VERCEL_ENV", "VERCEL_URL", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV"])(
    "is always off on a hosted platform (%s set), even with the flag", (marker) => {
      const env = { CLEANSTACK_TEST_MODE: "1", [marker]: "1" };
      expect(hostedPlatformMarker(env)).toBe(marker);
      expect(isTestMode(env)).toBe(false);
    });

  it("is off in this unit-test process (the flag is never set for unit tests)", () => {
    expect(isTestMode()).toBe(false);
  });
});

describe("checkEnv test-mode reporting", () => {
  it("errors when the flag is set on a hosted platform", () => {
    expect(checkEnv({ CLEANSTACK_TEST_MODE: "1", VERCEL: "1" }).errors.join()).toMatch(/hosted platform \(VERCEL\)/);
  });
  it("warns loudly when test mode is on", () => {
    expect(checkEnv({ CLEANSTACK_TEST_MODE: "1" }).warnings.join()).toMatch(/TEST MODE ENABLED/);
  });
  it("rejects the pg driver outside test mode", () => {
    expect(checkEnv({ DB_DRIVER: "pg" }).errors.join()).toMatch(/only allowed in test mode/);
    expect(checkEnv({ DB_DRIVER: "pg", CLEANSTACK_TEST_MODE: "1", VERCEL: "1" }).errors.join()).toMatch(/only allowed/);
  });
});
