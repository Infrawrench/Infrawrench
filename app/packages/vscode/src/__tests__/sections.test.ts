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
  "/vulnerabilities": {
    findings: [
      { severity: "critical", kev: { dateAdded: "2021-12-10" }, running: [{ resourceId: "r1" }] },
      { severity: "critical", kev: null, running: [{ resourceId: "r1" }] },
      { severity: "high", kev: null, running: [{ resourceId: "r1" }, { resourceId: "r9" }] },
    ],
    sources: [{ accountId: "acc" }],
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
    expect(text).toContain("Vulnerabilities: [2 critical, 1 high \\(1 known exploited\\)]");
    expect(text).toContain("command:infrawrench.openVulnerabilities");
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
      "2 critical, 1 high CVEs",
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

  it("asks for vulnerabilities once for the whole hover, scoped to its resources", async () => {
    const { ctx, org } = ctxWith(routes);
    const a = resource();
    const b = resource({ resourceId: "r2", externalId: "i-2" });
    const loaded = await loadSections(ctx, [a, b]);
    const calls = org.mock.calls.filter(([, path]) => String(path).startsWith("/vulnerabilities"));
    expect(calls.map(([, path]) => path)).toEqual(["/vulnerabilities?resourceId=r1&resourceId=r2"]);
    expect(renderResource(loaded, b).join("\n")).toContain("Vulnerabilities: none");
  });

  it("says nothing about vulnerabilities when the org has no scanner", async () => {
    const { ctx } = ctxWith({ ...routes, "/vulnerabilities": { findings: [], sources: [] } });
    const r = resource();
    const loaded = await loadSections(ctx, [r]);
    expect(loaded.failures.has("vulnerabilities")).toBe(false);
    expect(renderResource(loaded, r).join("\n")).not.toContain("Vulnerabilities");
    expect(lensSummary(loaded, r)).not.toContain(expect.stringContaining("CVE"));
  });

  it("accepts an appended section (the integration hook)", async () => {
    const { ctx } = ctxWith(routes);
    const extra: ResourceSection<number> = {
      id: "example",
      load: async (_c, rs) => new Map(rs.map((x) => [x.resourceId, 3])),
      render: (n) => (n ? [`Example: ${n}`] : []),
      lens: (n) => (n ? `${n} examples` : null),
    };
    const sections = [...RESOURCE_SECTIONS, extra as ResourceSection<unknown>];
    const r = resource();
    const loaded = await loadSections(ctx, [r], sections);
    expect(renderResource(loaded, r, sections)).toContain("Example: 3");
    expect(lensSummary(loaded, r, sections)).toContain("3 examples");
  });
});
