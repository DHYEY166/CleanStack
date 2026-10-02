import { describe, expect, it } from "vitest";
import { SIDECAR_PREFIX, isSidecarKey, stripSidecarKeys } from "@/lib/sidecar";

describe("sidecar keys", () => {
  it("matches the executor prefix", () => {
    expect(SIDECAR_PREFIX).toBe("__orig_");
    expect(isSidecarKey("__orig_name")).toBe(true);
    expect(isSidecarKey("name")).toBe(false);
    expect(isSidecarKey("orig_name")).toBe(false);
  });
  it("strips only sidecar keys and does not mutate the input", () => {
    const row = { id: 1, name: "a", __orig_name: "A " };
    expect(stripSidecarKeys(row)).toEqual({ id: 1, name: "a" });
    expect(row).toHaveProperty("__orig_name");
  });
});
