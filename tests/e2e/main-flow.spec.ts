/**
 * Main user flow in a real browser against the production build in test mode:
 * sign in -> upload a CSV (browser PUTs to the LocalStack presigned URL) ->
 * profiler (S3 notification) -> suggested rules (fake model) -> approve ->
 * executor (SQS) -> completed -> download -> no __orig_* columns.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FIXTURE = join(__dirname, "fixtures", "orders.csv");

test("sign in, upload, approve suggested rules, download a clean file", async ({ page }) => {
  const userId = `user_test_e2e_${randomUUID().slice(0, 8)}`;

  // Protected page -> test-mode sign-in -> back to the page
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?redirect_url=%2Fdashboard/);
  await page.getByLabel("Test user id").fill(userId);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Upload
  await page.goto("/pipelines/new");
  await page.getByPlaceholder("e.g. HubSpot CRM Cleaner").fill(`e2e ${userId}`);
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.getByRole("button", { name: /Create Pipeline & Upload/ }).click();

  // Profiler + fake model run; the page redirects to the run once rules exist
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]+\/runs\/[0-9a-f-]+$/, { timeout: 60_000 });
  await expect(page.getByText("awaiting approval", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  // Suggested rules from the deterministic fake model
  await page.getByRole("link", { name: /Open Data PR/ }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText("3 rules to review")).toBeVisible();
  for (const title of ["trim whitespace", "type cast", "normalize"]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("[fake-model] cast amount to float.")).toBeVisible();
  await expect(page.getByText("[fake-model] normalize order_date to YYYY-MM-DD.")).toBeVisible();

  // Approve all and submit
  await page.getByRole("button", { name: "Approve all" }).click();
  await page.getByRole("button", { name: /Submit Review/ }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  // Executor via SQS; the run page polls until completed
  const download = page.getByRole("button", { name: /Download CSV/ });
  await expect(download).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("completed", { exact: true }).first()).toBeVisible();

  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const csv = readFileSync(await file.path(), "utf8").trim().split(/\r?\n/);
  expect(csv[0].split(",")).toEqual(["order_id", "customer", "amount", "order_date"]);
  expect(csv.join("\n")).not.toContain("__orig_");
  expect(csv.slice(1)).toEqual([
    "1,Alice,10.5,2024-01-05",
    "2,Bob,20.0,2024-01-06",
    "3,Carol,30.25,2024-01-07",
    "4,Dan,5.0,2024-01-08",
  ]);
});
