import { describe, expect, it } from "vitest";
import {
  normalizeVulnerabilityFindings,
  normalizeVulnerabilitySeverity,
  type VulnerabilityFinding,
} from "../vulnerabilities.js";
import { resourceTypeDefinitionSchema } from "../validation/resource.schema.js";

function finding(over: Partial<VulnerabilityFinding> = {}): VulnerabilityFinding {
  return {
    id: "f1",
    advisoryId: "CVE-2024-0001",
    severity: "high",
    artifact: { kind: "image", name: "docker.io/library/nginx" },
    ...over,
  };
}

describe("normalizeVulnerabilitySeverity", () => {
  it("maps scanner words, including the vendor synonyms", () => {
    expect(normalizeVulnerabilitySeverity("CRITICAL")).toBe("critical");
    expect(normalizeVulnerabilitySeverity("Important")).toBe("high");
    expect(normalizeVulnerabilitySeverity("moderate")).toBe("medium");
    expect(normalizeVulnerabilitySeverity("NEGLIGIBLE")).toBe("low");
  });

  it("falls back to CVSS bands only when there is no word", () => {
    expect(normalizeVulnerabilitySeverity(undefined, 9.8)).toBe("critical");
    expect(normalizeVulnerabilitySeverity("UNTRIAGED", 7.5)).toBe("high");
    expect(normalizeVulnerabilitySeverity("", 5)).toBe("medium");
    expect(normalizeVulnerabilitySeverity(null, 2)).toBe("low");
  });

  // An unscored CVE must never read as low.
  it("is unknown when there is neither a word nor a score", () => {
    expect(normalizeVulnerabilitySeverity("UNTRIAGED")).toBe("unknown");
    expect(normalizeVulnerabilitySeverity(undefined, 0)).toBe("unknown");
  });
});

describe("normalizeVulnerabilityFindings", () => {
  it("drops findings that can be neither keyed nor joined, and duplicates", () => {
    const out = normalizeVulnerabilityFindings([
      finding(),
      finding({ id: "" }),
      finding({ id: "f2", advisoryId: "" }),
      finding({ id: "f3", artifact: { kind: "image", name: "" } }),
      finding({ title: "second copy" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBeUndefined();
  });

  it("removes impossible CVSS scores rather than clamping them", () => {
    const [f] = normalizeVulnerabilityFindings([finding({ cvssScore: 11 })]);
    expect(f!.cvssScore).toBeUndefined();
    const [g] = normalizeVulnerabilityFindings([finding({ cvssScore: 7.5 })]);
    expect(g!.cvssScore).toBe(7.5);
  });

  it("canonicalises advisory ids, aliases and digests", () => {
    const [f] = normalizeVulnerabilityFindings([
      finding({
        advisoryId: "ghsa-xxxx-yyyy-zzzz",
        aliases: ["cve-2024-1", "CVE-2024-1", "GHSA-XXXX-YYYY-ZZZZ"],
        artifact: { kind: "image", name: "r", digest: "SHA256:ABC" },
      }),
    ]);
    expect(f!.advisoryId).toBe("GHSA-XXXX-YYYY-ZZZZ");
    expect(f!.aliases).toEqual(["CVE-2024-1"]);
    expect(f!.artifact.digest).toBe("sha256:abc");
  });
});

describe("runningImages validation", () => {
  const base = {
    id: "t",
    displayName: "T",
    pluralDisplayName: "Ts",
    description: "d",
    fields: [],
    outputs: [],
    dashboardPinnable: false,
  };

  it("accepts a well-formed declaration", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...base,
        runningImages: { imageKeys: ["image"], runningKey: "status", runningValues: ["Running"] },
      }).success,
    ).toBe(true);
  });

  it("rejects a running field without values", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...base,
        runningImages: { imageKeys: ["image"], runningKey: "status" },
      }).success,
    ).toBe(false);
  });
});
