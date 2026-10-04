import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * A virtual tag's stored processing stats (spend per rule, top values) were
 * evaluated over the whole organization, so a caller with scoped cost access
 * gets the tag and its status without the money.
 */

const tag = {
  id: "vt-1",
  key: "team",
  name: "Team",
  status: {
    state: "ready",
    stats: {
      from: "2026-09-01",
      to: "2026-09-30",
      currencies: [
        {
          currency: "USD",
          total: 1000,
          unmatched: 100,
          byRule: [900],
          topValues: [{ value: "payments", amount: 900 }],
        },
      ],
      metricFallbackDays: 0,
      distinctValues: 3,
    },
  },
};

const listVirtualTags = vi.fn();
const getVirtualTag = vi.fn();
class VirtualTagError extends Error {}
class VirtualTagInUseError extends Error {}
class VirtualTagKeyConflictError extends Error {}
vi.mock("@infrawrench/server-core/cost/virtual-tags", () => ({
  VirtualTagError,
  VirtualTagInUseError,
  VirtualTagKeyConflictError,
  listVirtualTags: (...a: unknown[]) => listVirtualTags(...a),
  getVirtualTag: (...a: unknown[]) => getVirtualTag(...a),
  createVirtualTag: vi.fn(),
  deleteVirtualTag: vi.fn(),
  reprocessVirtualTag: vi.fn(),
  updateVirtualTag: vi.fn(),
}));
vi.mock("@infrawrench/server-core/cost/virtual-tag-pass", () => ({ previewVirtualTag: vi.fn() }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
// The real `requestIsCostScoped` runs; only the database-backed modules
// beside it are stubbed.
vi.mock("@infrawrench/server-core/cost/visibility", () => ({ resolveCostVisibility: vi.fn() }));
vi.mock("@/services/object-sharing", () => ({
  resolveSharingPrincipal: vi.fn(),
  runWithSharingPrincipal: (_p: unknown, fn: () => unknown) => fn(),
}));

const { virtualTagRoutes } = await import("../virtual-tags");

function app(restricted: boolean) {
  const outer = new Hono();
  outer.use("*", async (c, next) => {
    c.set(
      "costVisibility",
      restricted
        ? { organizationId: "org-1", restricted: true, userId: "user-1", layers: [] }
        : { organizationId: "org-1", restricted: false },
    );
    return next();
  });
  outer.route("/", buildTestApp(virtualTagRoutes));
  return outer;
}

beforeEach(() => {
  listVirtualTags.mockResolvedValue([tag]);
  getVirtualTag.mockResolvedValue(tag);
});

describe("virtual tag reads", () => {
  it("keep the processing figures for an unrestricted caller", async () => {
    const list = (await (await app(false).request("/")).json()) as (typeof tag)[];
    expect(list[0]!.status.stats.currencies).toHaveLength(1);
  });

  it("drop the whole-org money for a scoped caller, keeping the status", async () => {
    const list = (await (await app(true).request("/")).json()) as (typeof tag)[];
    expect(list[0]!.status.state).toBe("ready");
    expect(list[0]!.status.stats.currencies).toEqual([]);
    expect(list[0]!.status.stats.distinctValues).toBe(3);

    const one = (await (await app(true).request("/vt-1")).json()) as typeof tag;
    expect(one.status.stats.currencies).toEqual([]);
  });
});
