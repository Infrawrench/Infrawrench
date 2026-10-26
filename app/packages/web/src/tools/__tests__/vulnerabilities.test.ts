import { describe, it, expect, vi, beforeEach } from "vitest";

// Both server-core modules reach the db client at import time: stub them, they
// have their own tests. The filter is client-core's real one.
const mockListVulnerabilities = vi.fn();
vi.mock("@infrawrench/server-core/vulnerabilities/feed", () => ({
  listVulnerabilities: (...a: unknown[]) => mockListVulnerabilities(...a),
}));
const mockDismiss = vi.fn();
const mockRestore = vi.fn();
vi.mock("@infrawrench/server-core/vulnerabilities/dismissals", () => ({
  MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH: 500,
  dismissVulnerability: (...a: unknown[]) => mockDismiss(...a),
  restoreVulnerability: (...a: unknown[]) => mockRestore(...a),
}));
// People resolve through the role resolver (db); these cases are owners.
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: vi.fn(async () => ({ permissions: ["*"], role: null })),
}));
const mockLogAudit = vi.fn();
vi.mock("../../services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { vulnerabilityTools } = await import("../vulnerabilities");
const tools = vulnerabilityTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "chat" as const };

function finding(
  advisoryId: string,
  severity: string,
  opts: { running?: number; kev?: boolean; fix?: boolean; pluginId?: string } = {},
) {
  return {
    key: `a1:${advisoryId}`,
    accountId: "a1",
    accountName: "Prod",
    pluginId: opts.pluginId ?? "aws",
    pluginName: "AWS",
    scanner: "Inspector",
    findingId: advisoryId,
    advisoryId,
    aliases: [],
    title: null,
    severity,
    cvssScore: null,
    cvssVector: null,
    packageName: "openssl",
    packageEcosystem: null,
    installedVersion: "3.0.1",
    fixedVersion: opts.fix ? "3.0.2" : null,
    fixAvailable: opts.fix ?? null,
    exploitAvailable: null,
    kev: opts.kev ? { dateAdded: "2026-01-01", dueDate: null, knownRansomware: false } : null,
    artifact: {
      kind: "image",
      name: "registry/app",
      digest: null,
      tags: [],
      resourceExternalId: null,
      url: null,
      key: "image:registry/app",
    },
    firstSeenAt: null,
    lastSeenAt: null,
    url: null,
    collectedAt: "2026-10-01T00:00:00.000Z",
    running: Array.from({ length: opts.running ?? 0 }, (_, i) => ({ resourceId: `r${i}` })),
    services: opts.running ? [{ id: "svc-1", name: "Checkout", slug: "checkout", tier: 1 }] : [],
  };
}

const counts = { critical: 1, high: 1, medium: 1, low: 0, unknown: 0 };
const runningCounts = { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 };

function feed() {
  return {
    findings: [
      finding("CVE-1", "critical", { running: 2, kev: true, fix: true }),
      finding("CVE-2", "high", { fix: false, pluginId: "github" }),
      finding("CVE-3", "medium"),
    ],
    totalCount: 3,
    counts,
    runningCounts,
    dismissed: [
      {
        ...finding("CVE-9", "critical"),
        dismissal: {
          advisoryId: "CVE-9",
          artifactKey: "*",
          dismissedAt: "2026-09-01T00:00:00.000Z",
          dismissedBy: "Ada",
          reason: "not reachable",
        },
      },
    ],
    dismissedCount: 1,
    sources: [],
    kevUpdatedAt: "2026-10-01T00:00:00.000Z",
    generatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe("vulnerabilityTools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list_vulnerabilities filters but keeps whole-feed counts", async () => {
    mockListVulnerabilities.mockResolvedValue(feed());
    const out = parse(
      await tool("list_vulnerabilities").handler({ severity: ["critical", "high"] }, auth),
    );
    expect(mockListVulnerabilities).toHaveBeenCalledWith("o1", { withServices: true });
    expect(out.findings.map((f: { advisoryId: string }) => f.advisoryId)).toEqual([
      "CVE-1",
      "CVE-2",
    ]);
    expect(out.matchedCount).toBe(2);
    expect(out.totalCount).toBe(3);
    expect(out.counts).toEqual(counts);
    expect(out.runningCounts).toEqual(runningCounts);
    expect(out.dismissedCount).toBe(1);
    expect(out.dismissed).toBeUndefined();
    expect(out.kevUpdatedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("list_vulnerabilities describes only the allowed providers to a narrowed agent", async () => {
    mockListVulnerabilities.mockResolvedValue({
      ...feed(),
      sources: [
        { accountId: "a1", accountName: "Prod", pluginId: "aws" },
        { accountId: "a2", accountName: "Code", pluginId: "github" },
      ],
    });
    const agent = {
      ...auth,
      source: "mcp" as const,
      agentRegistrationId: "reg-1",
      scopes: ["resources:aws:read"],
    };
    const out = parse(await tool("list_vulnerabilities").handler({ pluginId: "aws" }, agent));
    expect(out.findings.map((f: { advisoryId: string }) => f.advisoryId)).toEqual([
      "CVE-1",
      "CVE-3",
    ]);
    // No trace of the GitHub finding in the totals or the scanner list.
    expect(out.totalCount).toBe(2);
    expect(out.counts).toEqual({ critical: 1, high: 0, medium: 1, low: 0, unknown: 0 });
    expect(out.sources.map((x: { pluginId: string }) => x.pluginId)).toEqual(["aws"]);
    expect(out.dismissedCount).toBe(1);
  });

  it("list_vulnerabilities filters by running, fix, KEV and plugin", async () => {
    mockListVulnerabilities.mockResolvedValue(feed());
    const ids = async (input: Record<string, unknown>) =>
      parse(await tool("list_vulnerabilities").handler(input, auth)).findings.map(
        (f: { advisoryId: string }) => f.advisoryId,
      );
    expect(await ids({ running: true })).toEqual(["CVE-1"]);
    expect(await ids({ running: false })).toEqual(["CVE-2", "CVE-3"]);
    expect(await ids({ fixAvailable: true })).toEqual(["CVE-1"]);
    expect(await ids({ kev: true })).toEqual(["CVE-1"]);
    expect(await ids({ pluginId: "github" })).toEqual(["CVE-2"]);
    expect(await ids({ search: "cve-3" })).toEqual(["CVE-3"]);
    expect(await ids({ resourceId: "r1" })).toEqual(["CVE-1"]);
    expect(await ids({ serviceId: "svc-1" })).toEqual(["CVE-1"]);
  });

  it("list_vulnerabilities caps rows with limit and says so", async () => {
    mockListVulnerabilities.mockResolvedValue(feed());
    const out = parse(await tool("list_vulnerabilities").handler({ limit: 1 }, auth));
    expect(out.findings).toHaveLength(1);
    expect(out.matchedCount).toBe(3);
    expect(out.truncated).toBe(true);
  });

  it("list_vulnerabilities returns dismissed rows only when asked, filtered the same way", async () => {
    mockListVulnerabilities.mockResolvedValue(feed());
    const out = parse(await tool("list_vulnerabilities").handler({ includeDismissed: true }, auth));
    expect(out.dismissed).toHaveLength(1);
    expect(out.dismissed[0].dismissal.reason).toBe("not reachable");

    const filtered = parse(
      await tool("list_vulnerabilities").handler(
        { includeDismissed: true, severity: ["low"] },
        auth,
      ),
    );
    expect(filtered.dismissed).toEqual([]);
  });

  it("dismiss_vulnerability records the acceptance with its author and audits it", async () => {
    mockDismiss.mockResolvedValue({
      id: "d1",
      advisoryId: "CVE-1",
      artifactKey: "*",
      dismissedAt: "2026-10-01T00:00:00.000Z",
      dismissedBy: "Ada",
      reason: "mitigated",
    });
    const r = await tool("dismiss_vulnerability").handler(
      { advisoryId: "CVE-1", artifactKey: "*", reason: "mitigated" },
      auth,
    );
    expect(mockDismiss).toHaveBeenCalledWith("o1", {
      advisoryId: "CVE-1",
      artifactKey: "*",
      reason: "mitigated",
      userId: "u1",
    });
    expect(parse(r).dismissed).toEqual({
      advisoryId: "CVE-1",
      artifactKey: "*",
      dismissedAt: "2026-10-01T00:00:00.000Z",
      dismissedBy: "Ada",
      reason: "mitigated",
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "vulnerability.dismissed",
        entityType: "vulnerability",
        entityId: "CVE-1",
        metadata: { artifactKey: "*", reason: "mitigated", source: "chat" },
      }),
    );
  });

  it("restore_vulnerability says so when nothing was dismissed", async () => {
    mockRestore.mockResolvedValue(false);
    const missing = await tool("restore_vulnerability").handler(
      { advisoryId: "cve-1", artifactKey: "*" },
      auth,
    );
    expect(missing.isError).toBe(true);
    expect(mockLogAudit).not.toHaveBeenCalled();

    mockRestore.mockResolvedValue(true);
    const r = await tool("restore_vulnerability").handler(
      { advisoryId: "cve-1", artifactKey: "*" },
      auth,
    );
    expect(mockRestore).toHaveBeenCalledWith("o1", "cve-1", "*");
    expect(r.isError).toBeUndefined();
    expect(parse(r).restored).toEqual({ advisoryId: "CVE-1", artifactKey: "*" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vulnerability.restored", entityId: "CVE-1" }),
    );
  });

  it("dismiss and restore need resources:write; listing needs resources:read", () => {
    expect(tool("list_vulnerabilities").permission).toBe("resources:read");
    expect(tool("dismiss_vulnerability").permission).toBe("resources:write");
    expect(tool("restore_vulnerability").permission).toBe("resources:write");
  });
});
