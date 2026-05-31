import { describe, it, expect } from "vitest";
import {
  dnsRecordBadgeColor,
  formatDnsTtl,
  dnsZoneStatus,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
} from "../dns.js";
import type { ResourceInstance } from "../instance.js";

function makeResource(fields: Record<string, string | number | boolean>): ResourceInstance {
  return {
    id: "rec-1",
    pluginId: "cloudflare",
    resourceTypeId: "dns-record",
    accountId: "acct-1",
    displayName: "example.com",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("dnsRecordBadgeColor", () => {
  it("maps known record types to colors", () => {
    expect(dnsRecordBadgeColor("A")).toBe("blue");
    expect(dnsRecordBadgeColor("CNAME")).toBe("green");
    expect(dnsRecordBadgeColor("MX")).toBe("yellow");
    expect(dnsRecordBadgeColor("TXT")).toBe("gray");
    expect(dnsRecordBadgeColor("CAA")).toBe("red");
  });

  it("falls back to gray for unknown types", () => {
    expect(dnsRecordBadgeColor("WEIRD")).toBe("gray");
  });
});

describe("formatDnsTtl", () => {
  it("returns Default for non-positive ttl", () => {
    expect(formatDnsTtl(0)).toBe("Default");
    expect(formatDnsTtl(-5)).toBe("Default");
  });

  it("returns Auto for ttl=1", () => {
    expect(formatDnsTtl(1)).toBe("Auto");
  });

  it("formats seconds", () => {
    expect(formatDnsTtl(30)).toBe("30s");
  });

  it("formats minutes", () => {
    expect(formatDnsTtl(120)).toBe("2m");
  });

  it("formats hours", () => {
    expect(formatDnsTtl(7200)).toBe("2h");
  });

  it("formats days", () => {
    expect(formatDnsTtl(172800)).toBe("2d");
  });
});

describe("dnsZoneStatus", () => {
  it("maps known statuses", () => {
    expect(dnsZoneStatus("active")).toBe("healthy");
    expect(dnsZoneStatus("pending")).toBe("provisioning");
    expect(dnsZoneStatus("initializing")).toBe("provisioning");
    expect(dnsZoneStatus("moved")).toBe("degraded");
    expect(dnsZoneStatus("deleted")).toBe("error");
    expect(dnsZoneStatus("deactivated")).toBe("error");
  });

  it("falls back to info for unknown status", () => {
    expect(dnsZoneStatus("whatever")).toBe("info");
  });
});

describe("renderDnsRecordDetail", () => {
  it("renders a basic A record (not proxied)", () => {
    const view = renderDnsRecordDetail(
      makeResource({ type: "A", name: "www.example.com", content: "1.2.3.4", ttl: 3600 }),
    );
    expect(view.title).toBe("www.example.com");
    expect(view.subtitle).toBe("A → 1.2.3.4");
    expect(view.status).toEqual({ kind: "status-dot", status: "info", label: "DNS Only" });
    // Record Details section exists with badges + key-value list
    const section = view.sections[0]!;
    expect(section.title).toBe("Record Details");
    // DNS Only badge for A type when not proxied
    const labels = section.children
      .filter((c) => c.kind === "badge")
      .map((c) => (c as { label: string }).label);
    expect(labels).toContain("A");
    expect(labels).toContain("DNS Only");
    expect(view.sections).toHaveLength(1);
  });

  it("renders a proxied record with proxy section and healthy status", () => {
    const view = renderDnsRecordDetail(
      makeResource({ type: "A", name: "p.example.com", content: "1.2.3.4", ttl: 1, proxied: true }),
    );
    expect(view.status).toEqual({ kind: "status-dot", status: "healthy", label: "Proxied" });
    expect(view.sections.map((s) => s.title)).toContain("Cloudflare Proxy");
    const badges = view.sections[0]!.children.filter((c) => c.kind === "badge").map(
      (c) => (c as { label: string }).label,
    );
    expect(badges).toContain("Proxied");
  });

  it("falls back to data field for content and truncates long subtitle", () => {
    const long = "x".repeat(80);
    const view = renderDnsRecordDetail(
      makeResource({ type: "TXT", name: "t.example.com", data: long, ttl: 60 }),
    );
    expect(view.subtitle).toBe(`TXT → ${"x".repeat(47)}...`);
  });

  it("includes priority, comment, and zone info items when present", () => {
    const view = renderDnsRecordDetail(
      makeResource({
        type: "MX",
        name: "example.com",
        content: "mail.example.com",
        ttl: 300,
        priority: 10,
        comment: "primary MX",
        zoneName: "example.com",
      }),
    );
    const kv = view.sections[0]!.children.find((c) => c.kind === "key-value-list") as {
      items: Array<{ key: string; value: string }>;
    };
    const keys = kv.items.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["Priority", "Comment", "Zone"]));
  });

  it("reads zone from domainName fallback", () => {
    const view = renderDnsRecordDetail(
      makeResource({ type: "A", name: "x", content: "1.2.3.4", ttl: 1, domainName: "z.com" }),
    );
    const kv = view.sections[0]!.children.find((c) => c.kind === "key-value-list") as {
      items: Array<{ key: string; value: string }>;
    };
    expect(kv.items.find((i) => i.key === "Zone")?.value).toBe("z.com");
  });

  it("appends extra info items and extra sections from options", () => {
    const view = renderDnsRecordDetail(
      makeResource({ type: "A", name: "x", content: "1.2.3.4", ttl: 1 }),
      {
        extraInfoItems: [{ key: "Custom", value: "v" }],
        extraSections: [{ kind: "section", title: "Extra", children: [] }],
      },
    );
    const kv = view.sections[0]!.children.find((c) => c.kind === "key-value-list") as {
      items: Array<{ key: string; value: string }>;
    };
    expect(kv.items.map((i) => i.key)).toContain("Custom");
    expect(view.sections.map((s) => s.title)).toContain("Extra");
  });

  it("does not add DNS Only badge for non-address types", () => {
    const view = renderDnsRecordDetail(
      makeResource({ type: "TXT", name: "x", content: "v=spf1", ttl: 1 }),
    );
    const badges = view.sections[0]!.children.filter((c) => c.kind === "badge").map(
      (c) => (c as { label: string }).label,
    );
    expect(badges).toEqual(["TXT"]);
  });
});

describe("renderDnsRecordSidebar", () => {
  it("renders label without proxied status", () => {
    const item = renderDnsRecordSidebar(makeResource({ type: "A", name: "www.example.com" }));
    expect(item.id).toBe("rec-1");
    expect(item.label).toBe("A  www.example.com");
    expect("status" in item).toBe(false);
  });

  it("adds proxied status when proxied", () => {
    const item = renderDnsRecordSidebar(
      makeResource({ type: "A", name: "p.example.com", proxied: true }),
    );
    expect(item.status).toEqual({ kind: "status-dot", status: "healthy", label: "Proxied" });
  });

  it("truncates long names", () => {
    const item = renderDnsRecordSidebar(makeResource({ type: "CNAME", name: "a".repeat(40) }));
    expect(item.label).toBe(`CNAME  ${"a".repeat(27)}...`);
  });
});
