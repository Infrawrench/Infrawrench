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
  complianceQueryString,
  compliancePackFileName,
  DEFAULT_COMPLIANCE_FRAMEWORK,
  fileNameFromContentDisposition,
  formatComplianceCounts,
  formatComplianceHeader,
  formatControlOwner,
  formatControlStatus,
  formatEvidenceStatus,
  parseComplianceFrameworkFlag,
  parseCompliancePeriodFlags,
  truncateText,
} from "../cli/compliance-format";
import { setColorEnabled } from "../cli/output";

beforeAll(() => setColorEnabled(false));

// The CLI keeps local copies of client-core's `evidencePackFileName` and
// `complianceQuery` (its client-core imports are type-only at module scope).
// These pin the copies to the originals. Imported dynamically: this test
// compiles as CommonJS and client-core is ESM.
let shared: {
  evidencePackFileName: (id: string, period: { from: string; to: string }) => string;
  complianceQuery: (id: string, period?: { from?: string; to?: string }) => string;
};
beforeAll(async () => {
  shared = await import("@infrawrench/client-core");
});

describe("parseCliArgs: compliance", () => {
  it("collects the framework, gaps and period", () => {
    const parsed = parseCliArgs([
      "compliance",
      "--framework",
      "iso27001",
      "--gaps",
      "--from",
      "2026-07-01",
      "--to",
      "2026-09-30",
    ]);
    expect(parsed.positionals).toEqual(["compliance"]);
    expect(parsed.compliance).toEqual({ framework: "iso27001", gaps: true });
    expect(parsed.range.from).toBe("2026-07-01");
    expect(parsed.range.to).toBe("2026-09-30");
  });

  it("defaults to no framework and no gaps filter", () => {
    expect(parseCliArgs(["compliance"]).compliance).toEqual({ framework: undefined, gaps: false });
  });

  it("reads the export destination from --out", () => {
    const parsed = parseCliArgs(["compliance", "export", "--out", "pack.zip", "--json"]);
    expect(parsed.positionals).toEqual(["compliance", "export"]);
    expect(parsed.config.out).toBe("pack.zip");
    expect(parsed.flags.output).toBe("json");
  });
});

describe("compliance flags", () => {
  it("defaults the framework to SOC 2 and normalizes case", () => {
    expect(parseComplianceFrameworkFlag(undefined)).toBe(DEFAULT_COMPLIANCE_FRAMEWORK);
    expect(DEFAULT_COMPLIANCE_FRAMEWORK).toBe("soc2");
    expect(parseComplianceFrameworkFlag(" ISO27001 ")).toBe("iso27001");
  });

  it("refuses something that cannot be a framework id", () => {
    expect(parseComplianceFrameworkFlag("../soc2")).toHaveProperty("error");
    expect(parseComplianceFrameworkFlag("")).toHaveProperty("error");
  });

  it("validates the period", () => {
    expect(parseCompliancePeriodFlags(undefined, undefined)).toEqual({});
    expect(parseCompliancePeriodFlags("2026-07-01", undefined)).toEqual({ from: "2026-07-01" });
    expect(parseCompliancePeriodFlags("2026-07-01", "2026-09-30")).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(parseCompliancePeriodFlags("07/01/2026", undefined)).toHaveProperty("error");
    expect(parseCompliancePeriodFlags(undefined, "2026-13-45")).toHaveProperty("error");
    expect(parseCompliancePeriodFlags("2026-09-30", "2026-07-01")).toHaveProperty("error");
  });
});

describe("compliance query + file name match client-core", () => {
  it.each([
    ["soc2", {}],
    ["iso27001", { from: "2026-07-01" }],
    ["soc2", { from: "2026-07-01", to: "2026-09-30" }],
  ] as const)("query for %s %j", (id, period) => {
    expect(complianceQueryString(id, period)).toBe(shared.complianceQuery(id, period));
  });

  it("names the pack the way the web download does", () => {
    const period = { from: "2026-07-01", to: "2026-09-30" };
    expect(compliancePackFileName("soc2", period)).toBe(
      shared.evidencePackFileName("soc2", period),
    );
    expect(compliancePackFileName("soc2", period)).toBe(
      "soc2-evidence-2026-07-01-to-2026-09-30.zip",
    );
  });
});

describe("fileNameFromContentDisposition", () => {
  it("reads quoted, bare and RFC 5987 names", () => {
    expect(fileNameFromContentDisposition('attachment; filename="soc2-evidence.zip"')).toBe(
      "soc2-evidence.zip",
    );
    expect(fileNameFromContentDisposition("attachment; filename=pack.zip")).toBe("pack.zip");
    expect(fileNameFromContentDisposition("attachment; filename*=UTF-8''iso%20pack.zip")).toBe(
      "iso pack.zip",
    );
  });

  it("drops directories and refuses empty or dot names", () => {
    expect(fileNameFromContentDisposition('attachment; filename="../../etc/passwd"')).toBe(
      "passwd",
    );
    expect(fileNameFromContentDisposition('attachment; filename=".."')).toBeNull();
    expect(fileNameFromContentDisposition("attachment")).toBeNull();
    expect(fileNameFromContentDisposition(null)).toBeNull();
  });
});

describe("compliance formatting", () => {
  it("names each control and evidence status", () => {
    expect(formatControlStatus("evidence")).toBe("evidence");
    expect(formatControlStatus("gaps")).toBe("gaps");
    expect(formatControlStatus("not-applicable")).toBe("n/a");
    expect(formatControlStatus("future-status")).toBe("future-status");
    expect(formatEvidenceStatus("no-data")).toBe("no data");
    expect(formatEvidenceStatus("unavailable")).toBe("unavailable");
  });

  it("sanitizes owners and says unowned", () => {
    // The ESC goes, so the printable remainder can no longer drive the terminal.
    expect(formatControlOwner({ displayName: "Platform\u001b[2J team" })).toBe("Platform[2J team");
    expect(formatControlOwner(null)).toBe("unowned");
    expect(formatControlOwner({ displayName: "   " })).toBe("unowned");
  });

  it("truncates with an ellipsis", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("a long control title", 8)).toBe("a long…");
    expect(truncateText("a long control title", 8).length).toBe(7);
  });

  it("summarizes counts, omitting empty optional buckets", () => {
    expect(
      formatComplianceCounts({ evidence: 9, gaps: 5, notApplicable: 2, total: 16, unowned: 3 }),
    ).toBe("9 with evidence · 5 with gaps · 2 not applicable · 3 unowned (of 16)");
    expect(
      formatComplianceCounts({ evidence: 16, gaps: 0, notApplicable: 0, total: 16, unowned: 0 }),
    ).toBe("16 with evidence · 0 with gaps (of 16)");
  });

  it("prints framework and period in the header", () => {
    expect(
      formatComplianceHeader(
        { name: "SOC 2", version: "2017 TSC" },
        { from: "2026-07-01", to: "2026-09-30" },
      ),
    ).toBe("SOC 2 2017 TSC · 2026-07-01 to 2026-09-30 (92 days)");
  });
});
