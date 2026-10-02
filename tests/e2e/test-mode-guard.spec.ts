/**
 * The e2e auth bypass must be unreachable outside test mode. Same build as the
 * main flow, started (a) without CLEANSTACK_TEST_MODE (:3101) and (b) with it
 * but on "Vercel" (VERCEL=1, :3102). Both use Clerk, so a forged test cookie
 * must not authenticate anything and /api/test-auth must not exist.
 */
import { expect, test } from "@playwright/test";

const servers = [
  { name: "flag unset", url: "http://localhost:3101" },
  { name: "flag set on Vercel", url: "http://localhost:3102" },
];

for (const { name, url } of servers) {
  test.describe(`test-mode bypass is off: ${name}`, () => {
    test("/api/test-auth does not exist and sets no cookie", async ({ request }) => {
      for (const method of ["POST", "DELETE", "GET"] as const) {
        const res = await request.fetch(`${url}/api/test-auth`, {
          method, data: method === "POST" ? { user_id: "user_test_attacker" } : undefined, maxRedirects: 0,
        });
        expect(res.status(), `${method} /api/test-auth`).toBe(404);
        expect(res.headers()["set-cookie"] ?? "").not.toContain("cs_test_user");
      }
    });

    test("a forged cs_test_user cookie is not a session", async ({ request }) => {
      const headers = { cookie: "cs_test_user=user_test_attacker" };
      for (const path of ["/api/usage", "/api/pipelines", "/dashboard"]) {
        const res = await request.get(`${url}${path}`, { headers, maxRedirects: 0 });
        expect([401, 403, 404], `${path} -> ${res.status()}`).toContain(res.status());
      }
    });
  });
}
