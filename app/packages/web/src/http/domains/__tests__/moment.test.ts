import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The union reaches every feed's tables; these tests are about the transport:
// the any-feed gate (no single permission), and the `at`/`window` sentences.
const mockCompute = vi.fn();
vi.mock("@/services/moment", () => ({
  MOMENT_FEED_PERMISSIONS: {
    changes: "resources:read",
    costAnomalies: "costs:read",
    audit: "audit:read",
  },
  parseMomentTimestamp: (raw: string) => {
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  },
  computeMoment: (...args: unknown[]) => mockCompute(...args),
}));

const { momentDomain } = await import("@/http/domains/moment/index");
const app = (permissions?: string[]) =>
  buildTestApi(momentDomain, {
    basePath: "/api/org/org-1/moment",
    ...(permissions === undefined ? {} : { permissions }),
  });

const response = {
  at: "2026-11-01T03:14:00.000Z",
  from: "2026-11-01T02:14:00.000Z",
  to: "2026-11-01T04:14:00.000Z",
  windowMinutes: 60,
  generatedAt: "2026-11-01T05:00:00.000Z",
  feeds: [],
  events: [],
  incidents: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCompute.mockResolvedValue(response);
});

describe("GET /moment", () => {
  it("refuses a caller who can read no feed, with the change feed's sentence", async () => {
    const res = await app(["dashboards:read"]).request("/");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: resources:read" });
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it("serves a caller holding any one feed's permission, passing the grants through", async () => {
    const res = await app(["costs:read"]).request("/?at=2026-11-01T03:14:00Z&window=30");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(response);
    expect(mockCompute).toHaveBeenCalledWith("org-1", {
      at: new Date("2026-11-01T03:14:00Z"),
      windowMinutes: 30,
      permissions: ["costs:read"],
    });
  });

  it("answers a bad timestamp or window with its own sentence", async () => {
    const at = await app().request("/?at=yesterday-ish");
    expect(at.status).toBe(400);
    expect(await at.json()).toEqual({ error: "Invalid 'at' timestamp" });
    const window = await app().request("/?window=0");
    expect(window.status).toBe(400);
    expect(await window.json()).toEqual({
      error: "Invalid 'window': expected a positive number of minutes",
    });
  });
});
