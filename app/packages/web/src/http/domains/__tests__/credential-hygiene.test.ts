import { describe, it, expect, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

const mockBuild = vi.fn(async (..._args: unknown[]) => ({ findings: [], windowDays: 90 }));
vi.mock("@infrawrench/server-core/hygiene/report", () => ({
  MIN_HYGIENE_WINDOW_DAYS: 7,
  MAX_HYGIENE_WINDOW_DAYS: 365,
  buildHygieneReport: (...a: unknown[]) => mockBuild(...a),
}));

const { credentialHygieneDomain } = await import("@/http/domains/credential-hygiene/index");
const buildApp = (permissions?: string[]) =>
  buildTestApi(credentialHygieneDomain, {
    basePath: "/api/org/org-1/credential-hygiene",
    ...(permissions ? { permissions } : {}),
  });

describe("credential hygiene route", () => {
  it("passes a valid window through and refuses one out of range", async () => {
    expect((await buildApp().request("/?windowDays=30")).status).toBe(200);
    expect(mockBuild).toHaveBeenCalledWith("org-1", { windowDays: 30 });
    const bad = await buildApp().request("/?windowDays=3");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "windowDays must be an integer between 7 and 365" });
  });

  it("is gated on audit:read", async () => {
    expect((await buildApp(["resources:read"]).request("/")).status).toBe(403);
  });
});
