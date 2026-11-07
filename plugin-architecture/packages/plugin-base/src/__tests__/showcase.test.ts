import { describe, expect, it } from "vitest";
import { fieldDefinitionSchema, validate } from "../validation/index.js";
import {
  buildResourceShowcase,
  omitLiveShowcaseStats,
  pickShowcaseValues,
  showcaseFields,
  showcaseStatusTone,
} from "../showcase.js";

const row = (key: string, label: string) => ({ key, label });
const rows = (s: { stats: Array<{ label: string; value: string }> }) =>
  s.stats.map((stat) => [stat.label, stat.value]);

describe("showcaseFields", () => {
  it("returns only the marked fields, in order", () => {
    const fields = [
      { key: "name", label: "Name", kind: "string" as const, required: true },
      { key: "region", label: "Region", kind: "string" as const, required: true, showcase: true },
      { key: "size", label: "Size", kind: "string" as const, required: true, showcase: true },
    ];
    expect(showcaseFields({ fields })).toEqual([row("region", "Region"), row("size", "Size")]);
  });
});

describe("the field schema", () => {
  it.each(["secret", "password"])("refuses to mark a %s field", (kind) => {
    const field = { key: "k", label: "K", kind, required: true, showcase: true };
    expect(validate(fieldDefinitionSchema, field).success).toBe(false);
  });

  it("accepts a marked string field", () => {
    const field = { key: "k", label: "K", kind: "string", required: true, showcase: true };
    expect(validate(fieldDefinitionSchema, field).success).toBe(true);
  });
});

describe("buildResourceShowcase", () => {
  it("makes a status line of a run-state field and rows of the rest, in field order", () => {
    const showcase = buildResourceShowcase(
      { status: "active", vcpus: 2, memoryMb: 4096, region: "nyc3", other: "hidden" },
      [
        row("vcpus", "vCPU"),
        row("memoryMb", "Memory (MB)"),
        row("status", "Status"),
        row("region", "Region"),
      ],
    );
    expect(showcase.status).toEqual({ key: "status", value: "Active", tone: "success" });
    expect(rows(showcase)).toEqual([
      ["vCPU", "2"],
      ["Memory (MB)", "4 GB"],
      ["Region", "nyc3"],
    ]);
  });

  it("shows nothing that wasn't marked", () => {
    expect(buildResourceShowcase({ region: "nyc3", status: "ok" }, [])).toEqual({ stats: [] });
    expect(buildResourceShowcase({ region: "nyc3" }, undefined)).toEqual({ stats: [] });
  });

  it("finds a run-state under a longer name", () => {
    const { status } = buildResourceShowcase({ provisioningState: "Succeeded" }, [
      row("provisioningState", "Provisioning State"),
    ]);
    expect(status).toMatchObject({ value: "Succeeded", tone: "success" });
  });

  it("reads a size's unit from the key or the label", () => {
    const showcase = buildResourceShowcase({ diskGb: 50, allocatedStorage: 100, sizeBytes: 2048 }, [
      row("diskGb", "Disk"),
      row("allocatedStorage", "Allocated Storage (GiB)"),
      row("sizeBytes", "Size"),
    ]);
    expect(rows(showcase)).toEqual([
      ["Disk", "50 GB"],
      ["Allocated Storage (GiB)", "100 GB"],
      ["Size", "2 KB"],
    ]);
  });

  it("skips a size listers defaulted to zero but keeps a real count of zero", () => {
    const showcase = buildResourceShowcase({ memoryMb: 0, replicas: 0 }, [
      row("memoryMb", "Memory"),
      row("replicas", "Replicas"),
    ]);
    expect(rows(showcase)).toEqual([["Replicas", "0"]]);
  });

  it("reduces a connection URL to its host, dropping credentials", () => {
    const { stats } = buildResourceShowcase({ host: "postgres://admin:hunter2@db.example.com/x" }, [
      row("host", "Host"),
    ]);
    expect(stats[0]?.value).toBe("db.example.com");
  });

  it("prints a date field as a date", () => {
    const { stats } = buildResourceShowcase({ createdAt: "2025-03-01T12:00:00Z" }, [
      row("createdAt", "Created"),
    ]);
    expect(stats[0]?.value).toMatch(/2025/);
  });

  it("leaves a date key alone when it doesn't hold a date", () => {
    const { stats } = buildResourceShowcase({ addOn: "backups" }, [row("addOn", "Add-on")]);
    expect(stats[0]?.value).toBe("backups");
  });

  it("hands a boolean back as a flag for the host to translate", () => {
    const { stats } = buildResourceShowcase({ multiAz: true }, [row("multiAz", "Multi-AZ")]);
    expect(stats[0]?.flag).toBe(true);
  });

  it("ignores nested values and stops at three rows, but still finds the status", () => {
    const showcase = buildResourceShowcase(
      { a: 1, b: { nested: true }, c: 2, d: 3, e: 4, status: "failed" },
      ["a", "b", "c", "d", "e", "status"].map((k) => row(k, k)),
    );
    expect(rows(showcase)).toEqual([
      ["a", "1"],
      ["c", "2"],
      ["d", "3"],
    ]);
    expect(showcase.status?.tone).toBe("danger");
  });
});

describe("showcaseStatusTone", () => {
  it.each([
    ["RUNNING", "success"],
    ["in-use", "success"],
    ["provisioning", "warning"],
    ["CrashLoopBackOff", "danger"],
    ["FAILED", "danger"],
    ["off", "neutral"],
    ["something-new", "neutral"],
  ])("%s reads as %s", (value, tone) => {
    expect(showcaseStatusTone(value)).toBe(tone);
  });
});

describe("omitLiveShowcaseStats", () => {
  const showcase = buildResourceShowcase({ status: "active", memory: "8 GB", region: "nyc3" }, [
    row("status", "Status"),
    row("memory", "Memory"),
    row("region", "Region"),
  ]);

  it("drops rows the live footer already shows, ignoring case", () => {
    const result = omitLiveShowcaseStats(showcase, [{ label: "MEMORY" }, { label: "Status" }]);
    expect(result.status).toBeUndefined();
    expect(result.stats.map((s) => s.label)).toEqual(["Region"]);
  });

  it("matches a field's label with its unit removed", () => {
    const sized = buildResourceShowcase({ memoryMb: 8192 }, [row("memoryMb", "Memory (MiB)")]);
    expect(omitLiveShowcaseStats(sized, [{ label: "Memory" }]).stats).toEqual([]);
  });

  it("leaves everything alone before the live stats arrive", () => {
    expect(omitLiveShowcaseStats(showcase, undefined)).toBe(showcase);
  });
});

describe("pickShowcaseValues", () => {
  it("keeps only the marked fields' values", () => {
    expect(
      pickShowcaseValues({ region: "nyc3", value: "hunter2" }, [row("region", "Region")]),
    ).toEqual({ region: "nyc3" });
  });
});
