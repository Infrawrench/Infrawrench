import { describe, expect, it, vi } from "vitest";
import type { VulnerabilityFindingRow } from "@infrawrench/client-core";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { parseKevFeed } = await import("../vulnerabilities/kev");
const { formatVulnerabilityAlert, vulnerabilityEventBatch } =
  await import("../vulnerabilities/alerts");
const { findingColumns } = await import("../vulnerabilities/collect");

describe("parseKevFeed", () => {
  // Shape copied from the live feed (2026-10-08 catalog).
  it("maps entries and drops malformed ones", () => {
    const rows = parseKevFeed({
      catalogVersion: "2026.10.08",
      vulnerabilities: [
        {
          cveID: "CVE-2021-44228",
          vendorProject: "Apache",
          product: "Log4j2",
          vulnerabilityName: "Apache Log4j2 Remote Code Execution Vulnerability",
          dateAdded: "2021-12-10",
          dueDate: "2021-12-24",
          knownRansomwareCampaignUse: "Known",
        },
        { cveID: "not-a-cve", dateAdded: "2021-12-10" },
        { cveID: "CVE-2015-5477", dateAdded: "2026-10-08", knownRansomwareCampaignUse: "Unknown" },
        { cveID: "CVE-2015-5477", dateAdded: "2026-10-08" },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      cveId: "CVE-2021-44228",
      dueDate: "2021-12-24",
      knownRansomware: true,
    });
    expect(rows[1]).toMatchObject({
      cveId: "CVE-2015-5477",
      dueDate: null,
      knownRansomware: false,
    });
  });

  it("refuses a feed without the array", () => {
    expect(() => parseKevFeed({})).toThrow();
  });
});

describe("findingColumns", () => {
  it("keeps only https links and parses instants", () => {
    const cols = findingColumns({
      id: "f",
      advisoryId: "CVE-1",
      severity: "high",
      url: "javascript:alert(1)",
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "garbage",
      artifact: { kind: "image", name: "r", url: "https://console.example.com/r" },
    });
    expect(cols.url).toBeNull();
    expect(cols.artifactUrl).toBe("https://console.example.com/r");
    expect(cols.firstSeenAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(cols.lastSeenAt).toBeNull();
    expect(cols.fixAvailable).toBeNull();
  });
});

function row(over: Partial<VulnerabilityFindingRow> = {}): VulnerabilityFindingRow {
  return {
    key: "a\u0000f",
    accountId: "a",
    accountName: "A",
    pluginId: "aws",
    pluginName: "AWS",
    scanner: "Amazon Inspector",
    findingId: "f",
    advisoryId: "CVE-2024-1",
    aliases: [],
    title: null,
    severity: "critical",
    cvssScore: 9.8,
    cvssVector: null,
    packageName: "openssl",
    packageEcosystem: null,
    installedVersion: "3.0.1",
    fixedVersion: "3.0.2",
    fixAvailable: true,
    exploitAvailable: null,
    kev: null,
    artifact: {
      kind: "image",
      name: "ghcr.io/acme/api",
      digest: null,
      tags: [],
      resourceExternalId: null,
      url: null,
      key: "image:ghcr.io/acme/api",
    },
    firstSeenAt: null,
    lastSeenAt: null,
    url: null,
    collectedAt: "2026-10-01T00:00:00.000Z",
    running: [
      {
        resourceId: "p1",
        pluginId: "kubernetes",
        resourceTypeId: "k8s-pod",
        resourceTypeName: "Pod",
        resourceTypePluralName: "Pods",
        accountId: "k",
        accountName: "K",
        displayName: "p1",
        matchedBy: "digest",
      },
    ],
    ...over,
  };
}

describe("formatVulnerabilityAlert", () => {
  it("names the running join in one finding's message", () => {
    const m = formatVulnerabilityAlert([row()]);
    expect(m.title).toBe("1 new vulnerability (1 critical), 1 running");
    expect(m.pushBody).toBe(
      "CVE-2024-1 (critical) in openssl 3.0.1 (fixed in 3.0.2): ghcr.io/acme/api, running in 1 Pod",
    );
  });

  it("caps the list and flags KEV", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      row({
        key: String(i),
        advisoryId: `CVE-2024-${i}`,
        kev: { dateAdded: "2024-01-01", dueDate: null, knownRansomware: false },
      }),
    );
    const m = formatVulnerabilityAlert(many);
    expect(m.body.split("\n")).toHaveLength(9);
    expect(m.body).toContain("[known exploited]");
    expect(m.body).toContain("and 2 more");
  });
});

describe("vulnerabilityEventBatch", () => {
  const kev = { dateAdded: "2024-01-01", dueDate: null, knownRansomware: false };

  it("sends known exploited first, then by severity, then by how much runs it", () => {
    const batch = vulnerabilityEventBatch([
      row({ key: "low", severity: "low" }),
      row({ key: "high-idle", severity: "high", running: [] }),
      row({ key: "high-running", severity: "high" }),
      row({ key: "medium-kev", severity: "medium", kev }),
      row({ key: "critical", severity: "critical" }),
    ]);
    expect(batch.map((f) => f.key)).toEqual([
      "medium-kev",
      "critical",
      "high-running",
      "high-idle",
      "low",
    ]);
  });

  it("caps the batch without reordering the input", () => {
    const input = Array.from({ length: 5 }, (_, i) => row({ key: String(i) }));
    expect(vulnerabilityEventBatch(input, 2).map((f) => f.key)).toEqual(["0", "1"]);
    expect(input.map((f) => f.key)).toEqual(["0", "1", "2", "3", "4"]);
  });
});
