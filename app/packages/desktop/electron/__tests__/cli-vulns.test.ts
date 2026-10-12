import { beforeAll, describe, expect, it, vi } from "vitest";

// `cli/args` reaches `cli/context` for CliError, which pulls the Electron app
// object and the plugin host at import time. None of it runs here.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { parseCliArgs } from "../cli/args";
import {
  formatAgo,
  formatKevFreshness,
  formatVulnAdvisory,
  formatVulnArtifact,
  formatVulnCvss,
  formatVulnPackage,
  matchVulnAccount,
  parseVulnSeverityFlag,
} from "../cli/format";
import { setColorEnabled } from "../cli/output";

beforeAll(() => setColorEnabled(false));

describe("parseCliArgs: vulns", () => {
  it("collects the list filters", () => {
    const parsed = parseCliArgs([
      "vulns",
      "--severity",
      "critical,high",
      "--running",
      "--fix-available",
      "--kev",
      "--plugin",
      "aws",
      "-a",
      "Prod",
      "--search",
      "openssl",
      "--include-dismissed",
      "--limit",
      "20",
    ]);
    expect(parsed.positionals).toEqual(["vulns"]);
    expect(parsed.vulns).toEqual({
      severity: "critical,high",
      running: true,
      fixAvailable: true,
      kev: true,
      plugin: "aws",
      search: "openssl",
      includeDismissed: true,
    });
    expect(parsed.flags.account).toBe("Prod");
    expect(parsed.range.limit).toBe(20);
  });

  it("reads --not-running as running: false, and neither as both", () => {
    expect(parseCliArgs(["vulns", "--not-running"]).vulns.running).toBe(false);
    expect(parseCliArgs(["vulns"]).vulns.running).toBeUndefined();
  });

  it("rejects --running with --not-running", () => {
    expect(() => parseCliArgs(["vulns", "--running", "--not-running"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("takes dismiss positionals and the shared --reason", () => {
    const parsed = parseCliArgs([
      "vulns",
      "dismiss",
      "CVE-2024-3094",
      "*",
      "--reason",
      "not reachable",
    ]);
    expect(parsed.positionals).toEqual(["vulns", "dismiss", "CVE-2024-3094", "*"]);
    expect(parsed.flags.reason).toBe("not reachable");
  });
});

describe("vulns formatting", () => {
  it("parses --severity, accepting unscored and naming the rest", () => {
    expect(parseVulnSeverityFlag("Critical, high,unscored,high")).toEqual({
      severities: ["critical", "high", "unknown"],
      invalid: [],
    });
    expect(parseVulnSeverityFlag("critical,severe")).toEqual({
      severities: ["critical"],
      invalid: ["severe"],
    });
  });

  it("shows installed -> fixed, or says there is no fix", () => {
    const base = { packageName: "openssl", installedVersion: "3.0.1" };
    expect(formatVulnPackage({ ...base, fixedVersion: "3.0.2", fixAvailable: true })).toBe(
      "openssl 3.0.1 -> 3.0.2",
    );
    expect(formatVulnPackage({ ...base, fixedVersion: null, fixAvailable: false })).toBe(
      "openssl 3.0.1 (no fix)",
    );
    expect(formatVulnPackage({ ...base, fixedVersion: null, fixAvailable: null })).toBe(
      "openssl 3.0.1",
    );
  });

  it("marks KEV advisories", () => {
    expect(formatVulnAdvisory({ advisoryId: "CVE-1", kev: null })).toBe("CVE-1");
    expect(formatVulnAdvisory({ advisoryId: "CVE-1", kev: { knownRansomware: false } })).toBe(
      "CVE-1 KEV",
    );
    expect(formatVulnAdvisory({ advisoryId: "CVE-1", kev: { knownRansomware: true } })).toBe(
      "CVE-1 KEV ransomware",
    );
  });

  it("formats CVSS and artifacts", () => {
    expect(formatVulnCvss(9.81)).toBe("9.8");
    expect(formatVulnCvss(null)).toBe("-");
    expect(formatVulnArtifact({ name: "ghcr.io/acme/api", tags: ["1.4"], digest: null })).toBe(
      "ghcr.io/acme/api:1.4",
    );
    expect(
      formatVulnArtifact({ name: "ghcr.io/acme/api", tags: [], digest: "sha256:abcdef0123456789" }),
    ).toBe("ghcr.io/acme/api@abcdef012345");
  });

  it("resolves --account by id, name, or unique prefix", () => {
    const sources = [
      { accountId: "a1", accountName: "Prod" },
      { accountId: "a2", accountName: "Production EU" },
      { accountId: "a3", accountName: "Staging" },
    ];
    expect(matchVulnAccount(sources, "a3")).toBe("a3");
    expect(matchVulnAccount(sources, "prod")).toBe("a1");
    expect(matchVulnAccount(sources, "stag")).toBe("a3");
    // Ambiguous prefix and no match both refuse rather than guess.
    expect(matchVulnAccount(sources, "pro")).toBeNull();
    expect(matchVulnAccount(sources, "dev")).toBeNull();
  });

  it("describes KEV freshness and flags a stale mirror", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(formatAgo("2026-10-12T09:00:00Z", now)).toBe("3h ago");
    expect(formatKevFreshness("2026-10-12T09:00:00Z", now)).toBe("CISA KEV catalog updated 3h ago");
    expect(formatKevFreshness("2026-10-01T12:00:00Z", now)).toBe(
      "CISA KEV catalog updated 11d ago (stale)",
    );
    expect(formatKevFreshness(null, now)).toMatch(/not fetched/);
  });
});
