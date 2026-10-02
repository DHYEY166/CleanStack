import { describe, expect, it } from "vitest";
import { GUEST_LIMITS, isGuestBlockedPath } from "./guest-limits";

describe("guest limits", () => {
  it("match the approved numbers", () => {
    expect(GUEST_LIMITS).toMatchObject({
      maxUploadBytes: 2 * 1024 * 1024, rowsPerRun: 5_000, rowsPerGuest: 10_000, uploadsPerGuest: 3,
      uploadsPerIpPerDay: 10, aiCallsPerHour: 10, aiSpendPerGuestUsd: 0.25, aiSpendAllGuestsPerDayUsd: 5,
    });
  });

  it.each([
    ["/api/chat-builder", true], ["/api/chat-builder/generate-data", true], ["/api/runs/abc/auto-clean", true],
    ["/api/export-training/abc", true], ["/api/alerts/configure", true], ["/api/account", true],
    ["/api/templates", true], ["/api/templates/x/use", true], ["/api/admin/set-plan", true], ["/templates", true],
    ["/api/runs/abc/iterate", false], ["/api/upload", false], ["/api/pipelines", false], ["/dashboard", false],
    ["/api/chat-builderx", false], ["/templatesx", false], ["/api/runs/abc/auto-clean/x", false],
  ])("%s blocked=%s", (path, blocked) => {
    expect(isGuestBlockedPath(path)).toBe(blocked);
  });
});
