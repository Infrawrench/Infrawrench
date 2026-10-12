import { describe, expect, it, vi } from "vitest";
import type { CloudFetch, IacReconciliationEntry } from "@infrawrench/client-core";
import { TtlCache } from "../cache";
import {
  RESOURCE_SECTIONS,
  lensSummary,
  loadSections,
  renderResource,
  type ResourceSection,
  type SectionContext,
} from "../sections";

function resource(over: Partial<IacReconciliationEntry> = {}): IacReconciliationEntry {
  return {
    resourceId: "r1",
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    accountId: "acc",
    displayName: "web-1",
    externalId: "i-1",
    status: "managed",
    terraformType: "aws_instance",
    terraformAddress: "aws_instance.web",
    matchedBy: "external-id",
    drift: [],
    unmappableReason: null,
    owner: null,
    firstSeenAt: null,
    ...over,
  };
}

function ctxWith(routes: Record<string, unknown>): {
  ctx: SectionContext;
  org: ReturnType<typeof vi.fn>;
} {
  const org = vi.fn(async (_orgId: string, path: string) => {
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected ${path}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    return value;
  });
  return {
    org,
    ctx: {
      api: { org } as unknown as CloudFetch,
      orgId: "o",
      caches: { posture: new TtlCache(60_000), perResource: new TtlCache(60_000) },
    },
  };
}

const routes = {
  "/services/for-resources": {
    services: { r1: [{ id: "s1", name: "Checkout", slug: "checkout", tier: 1 }] },
  },
  "/costs/query": {
    series: [
      {
        key: "i-1",
        label: "i-1",
        currency: "USD",
        points: [{ bucket: "2026-10-01", amount: 42.5 }],
      },
    ],
  },
  "/resources/cost-estimate": {
    estimate: { monthlyAmount: 40, currency: "USD", lineItems: [], partial: false },
  },
  "/posture": {
    findings: [
      { resourceId: "r1", severity: "high", title: "Port 22 open to the world", ruleId: "a" },
      { resourceId: "r1", severity: "critical", title: "Public snapshot", ruleId: "b" },
    ],
  },
};

describe("hover sections", () => {
  it("renders every section for a resource", async () => {
    const { ctx } = ctxWith(routes);
    const r = resource();
    const loaded = await loadSections(ctx, [r]);
    const text = renderResource(loaded, r).join("\n");
    expect(text).toContain("**Managed** by Terraform");
    expect(text).toContain("Checkout");
    expect(text).toContain("Tier 1");
    expect(text).toContain("Cost (last 30 days): $42.50");
    expect(text).toContain("Estimate: $40/month");
    expect(text).toContain("Posture: 2 open finding(s)");
    // Worst first.
    expect(text.indexOf("Critical")).toBeLessThan(text.indexOf("High"));
  });

  it("summarises drift and builds a CodeLens line", async () => {
    const { ctx } = ctxWith(routes);
    const r = resource({
      status: "drifted",
      drift: [{ field: "instance_type", from: "a", to: "b" }],
    });
    const loaded = await loadSections(ctx, [r]);
    expect(renderResource(loaded, r)[0]).toContain("1 field(s) differ");
    expect(lensSummary(loaded, r)).toEqual([
      "drifted (1)",
      "Checkout",
      "$42.50 / 30d",
      "2 finding(s), worst critical",
    ]);
  });

  it("drops a section that failed (a 403) instead of failing the hover", async () => {
    const { ctx } = ctxWith({ ...routes, "/posture": new Error("403") });
    const r = resource();
    const loaded = await loadSections(ctx, [r]);
    expect(loaded.failures.has("posture")).toBe(true);
    expect(renderResource(loaded, r).join("\n")).not.toContain("Posture");
  });

  it("says no cost data rather than $0, and caches per resource", async () => {
    const { ctx, org } = ctxWith({ ...routes, "/costs/query": { series: [] } });
    const r = resource();
    const first = await loadSections(ctx, [r]);
    expect(renderResource(first, r).join("\n")).toContain("no cost data");
    const calls = org.mock.calls.length;
    await loadSections(ctx, [r]);
    expect(org.mock.calls.length).toBe(calls);
  });

  it("accepts an appended section (the integration hook)", async () => {
    const { ctx } = ctxWith(routes);
    const extra: ResourceSection<number> = {
      id: "vulnerabilities",
      load: async (_c, rs) => new Map(rs.map((x) => [x.resourceId, 3])),
      render: (n) => (n ? [`Vulnerabilities: ${n}`] : []),
      lens: (n) => (n ? `${n} CVEs` : null),
    };
    const sections = [...RESOURCE_SECTIONS, extra as ResourceSection<unknown>];
    const r = resource();
    const loaded = await loadSections(ctx, [r], sections);
    expect(renderResource(loaded, r, sections)).toContain("Vulnerabilities: 3");
    expect(lensSummary(loaded, r, sections)).toContain("3 CVEs");
  });
});
