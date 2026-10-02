/**
 * Guest access in a real browser (production build, test mode): POST /api/guest
 * sets the signed cs_guest cookie, the guest can open protected pages, sees a
 * 2 MB per-file limit, uploads through the presigned POST and reaches review.
 * Guests are kept out of blocked features and capped at 3 uploads. Each test
 * uses its own X-Forwarded-For so the per-IP caps never interfere. The full
 * flow starts from the sign-in page button and runs the sample data to a download.
 */
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SAMPLE_CLEAN_LINES } from "../support/sample-expected";
import { randomUUID } from "node:crypto";

const FIXTURE = join(__dirname, "fixtures", "orders.csv");

async function startGuest(page: Page) {
  const res = await page.request.post("/api/guest", { headers: { "x-forwarded-for": `e2e-${randomUUID()}` } });
  expect(res.status()).toBe(201);
  const cookie = (await page.context().cookies()).find((c) => c.name === "cs_guest");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.value).toMatch(/^guest_[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]+$/);
}

test("a guest uploads a CSV through the presigned POST and reaches review", async ({ page }) => {
  await startGuest(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/pipelines/new");
  await expect(page.getByText("Max 2 MB per file")).toBeVisible();
  await page.getByPlaceholder("e.g. HubSpot CRM Cleaner").fill(`guest e2e ${randomUUID().slice(0, 8)}`);
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.getByRole("button", { name: /Create Pipeline & Upload/ }).click();
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]+\/runs\/[0-9a-f-]+$/, { timeout: 60_000 });
  await expect(page.getByText("awaiting approval", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
});

test("a guest's file over 2 MB is refused in the form and by /api/upload", async ({ page }) => {
  await startGuest(page);
  await page.goto("/pipelines/new");
  await expect(page.getByText("Max 2 MB per file")).toBeVisible();
  const big = Buffer.from("id,v\n" + "1,x\n".repeat(560_000)); // ~2.1 MB
  await page.locator('input[type="file"]').setInputFiles({ name: "big.csv", mimeType: "text/csv", buffer: big });
  await expect(page.getByText("File is 2.1 MB; the limit is 2 MB per file.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Create Pipeline & Upload/ })).toBeDisabled();

  // A client that skips the form check gets 413 from the server (and S3 would reject the bytes).
  const created = await page.request.post("/api/pipelines", { data: { name: "guest big" } });
  const { pipeline } = await created.json();
  const res = await page.request.post("/api/upload", { data: { pipeline_id: pipeline.id, filename: "big.csv", size: big.length } });
  expect(res.status()).toBe(413);
  expect((await res.json()).error).toBe("File is 2.1 MB; the limit is 2 MB per file.");
});

test("a forged or tampered guest cookie is not a session", async ({ request }) => {
  for (const value of ["guest_AAAAAAAAAAAAAAAAAAAAAA.9999999999.forged", "guest_AAAAAAAAAAAAAAAAAAAAAA"]) {
    const res = await request.get("/api/usage", { headers: { cookie: `cs_guest=${value}` }, maxRedirects: 0 });
    expect(res.status()).toBe(401);
  }
});

test("guests are kept out of blocked features and capped at 3 uploads", async ({ page }) => {
  await startGuest(page);
  await page.goto("/templates");
  await expect(page).toHaveURL(/\/dashboard\?guest_blocked=1$/);
  for (const [method, path] of [["POST", "/api/chat-builder"], ["POST", "/api/chat-builder/generate-data"], ["GET", "/api/templates"],
    ["POST", "/api/alerts/configure"], ["DELETE", "/api/account?confirm=true"], ["GET", "/api/export-training/00000000-0000-0000-0000-000000000000"]] as const) {
    const res = await page.request.fetch(path, { method, data: method === "GET" ? undefined : {} });
    expect(res.status(), `${method} ${path}`).toBe(403);
    expect((await res.json()).guest).toBe(true);
  }

  const { pipeline } = await (await page.request.post("/api/pipelines", { data: { name: "guest caps" } })).json();
  const start = () => page.request.post("/api/upload", { data: { pipeline_id: pipeline.id, filename: "a.csv", size: 100 } });
  for (let i = 0; i < 3; i++) expect((await start()).status()).toBe(200);
  const fourth = await start();
  expect(fourth.status()).toBe(429);
  expect((await fourth.json()).error).toBe("Guests can upload 3 files. Sign up to keep going.");
});

test("full guest flow: try as guest -> sample data -> approve -> completed -> download -> end session", async ({ page }) => {
  // Give this browser its own client IP for the per-IP guest caps.
  const ip = `e2e-${randomUUID()}`;
  await page.route("**/api/guest", (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }));

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Try as guest, no sign-up" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("guest-banner")).toContainText("Guest session: everything is deleted in 23 h");
  await expect(page.getByRole("link", { name: "Sign up to keep your work" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Templates" })).toHaveCount(0);

  // Sample data: template rules, no AI
  await page.getByRole("button", { name: "Try with sample data" }).click();
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]+\/runs\/[0-9a-f-]+$/, { timeout: 30_000 });
  await expect(page.getByText("awaiting approval", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: /Open Data PR/ }).click();
  await expect(page.getByText("6 rules to review")).toBeVisible();
  await expect(page.getByText("Orders 1004 and 1011 appear twice with identical values.")).toBeVisible();
  await page.getByRole("button", { name: "Approve all" }).click();
  await page.getByRole("button", { name: /Submit Review/ }).click();

  const download = page.getByRole("button", { name: /Download CSV/ });
  await expect(download).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("completed", { exact: true }).first()).toBeVisible();
  // Guests get no auto-clean or training export
  await expect(page.getByRole("button", { name: /auto-clean|Run remaining passes/i })).toHaveCount(0);
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  const csv = readFileSync(await file.path(), "utf8").trim().split(/\r?\n/);
  expect(csv).toEqual(SAMPLE_CLEAN_LINES);

  // End the session: cookie cleared, protected pages need sign-in again
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await page.context().cookies()).find((c) => c.name === "cs_guest")).toBeUndefined();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in/);
});
