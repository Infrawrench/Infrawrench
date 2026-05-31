import { describe, it, expect } from "vitest";
import { gcpStatus, parseFormArg, formatGcpError, gcpFetch } from "../utils.js";
import {
  isPermissionError,
  shortImage,
  formatBackupSize,
  formatRelativeTime,
  formatPitrRetention,
  bigQuerySchemaToRows,
} from "../shared-renderers.js";
import {
  regionFromZone,
  geoFromRegion,
  estimateMachineTypeMonthlyPrices,
  type PricingRates,
} from "../pricing.js";
import { engineInfoFromVersion, buildConnectionUrl } from "../cloudsql-engine.js";
import { regionOption, GCP_REGIONS, PUBLIC_IMAGES, CLOUD_BUILD_REGIONS } from "../regions.js";
import { parseBigQueryDatasetExternalId } from "../bigquery-spanner-handlers.js";

describe("gcpStatus", () => {
  it("maps healthy states", () => {
    for (const s of ["RUNNING", "active", "Ready", "SERVING", "DEPLOYED", "SUCCEEDED", "ENABLED"]) {
      expect(gcpStatus(s)).toBe("healthy");
    }
  });
  it("maps degraded / error / provisioning / info", () => {
    expect(gcpStatus("SUSPENDED")).toBe("degraded");
    expect(gcpStatus("FAILED")).toBe("error");
    expect(gcpStatus("CREATING")).toBe("provisioning");
    expect(gcpStatus("WAT")).toBe("info");
    expect(gcpStatus(undefined)).toBe("info");
  });
});

describe("parseFormArg", () => {
  it("returns {} for non-string", () => {
    expect(parseFormArg(undefined)).toEqual({});
    expect(parseFormArg(42)).toEqual({});
  });
  it("returns {} for invalid JSON", () => {
    expect(parseFormArg("not json")).toEqual({});
  });
  it("coerces values to strings and nullish to empty", () => {
    expect(parseFormArg(JSON.stringify({ a: 1, b: null, c: "x" }))).toEqual({
      a: "1",
      b: "",
      c: "x",
    });
  });
});

describe("formatGcpError", () => {
  it("prefers error.message and status", async () => {
    const res = new Response(JSON.stringify({ error: { message: "boom", status: "NOT_FOUND" } }), {
      status: 404,
    });
    expect(await formatGcpError("Op", res)).toBe("NOT_FOUND: boom");
  });
  it("uses operation+status when no status field", async () => {
    const res = new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    expect(await formatGcpError("Op", res)).toBe("Op failed (500): boom");
  });
  it("falls back to raw truncated body for non-error JSON", async () => {
    const res = new Response("plain text body", { status: 400 });
    expect(await formatGcpError("Op", res)).toBe("Op failed (400): plain text body");
  });
  it("truncates long bodies", async () => {
    const long = "x".repeat(500);
    const res = new Response(long, { status: 400 });
    const out = await formatGcpError("Op", res);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(500);
  });
});

describe("gcpFetch", () => {
  it("adds bearer token + JSON content type and merges init headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}");
    }) as typeof fetch;
    try {
      await gcpFetch({ token: async () => "tok" }, "https://x", {
        method: "POST",
        headers: { "X-Test": "1" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls[0]!.url).toBe("https://x");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Test"]).toBe("1");
    expect(calls[0]!.init.method).toBe("POST");
  });
});

describe("shared-renderers helpers", () => {
  it("isPermissionError", () => {
    expect(isPermissionError("Permission denied")).toBe(true);
    expect(isPermissionError("caller does not have")).toBe(true);
    expect(isPermissionError("Forbidden")).toBe(true);
    expect(isPermissionError("access denied")).toBe(true);
    expect(isPermissionError("not found")).toBe(false);
  });
  it("shortImage", () => {
    expect(shortImage("")).toBe("—");
    expect(shortImage("gcr.io/p/img:tag")).toBe("gcr.io/p/img:tag");
    expect(shortImage("gcr.io/p/img@sha256:abcdef0123456789")).toBe("gcr.io/p/img@abcdef012345");
  });
  it("formatBackupSize", () => {
    expect(formatBackupSize(0)).toBe("—");
    expect(formatBackupSize("0")).toBe("—");
    expect(formatBackupSize("notnum")).toBe("—");
    expect(formatBackupSize(512)).toBe("512 B");
    expect(formatBackupSize(1536)).toBe("1.5 KB");
    expect(formatBackupSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
  it("formatRelativeTime", () => {
    expect(formatRelativeTime("")).toBe("—");
    expect(formatRelativeTime("not a date")).toBe("not a date");
    expect(formatRelativeTime(new Date(Date.now() - 10_000).toISOString())).toBe("just now");
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 mins ago");
    expect(formatRelativeTime(new Date(Date.now() - 2 * 3_600_000).toISOString())).toBe(
      "2 hrs ago",
    );
    expect(formatRelativeTime(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe(
      "3 days ago",
    );
  });
  it("formatPitrRetention", () => {
    expect(formatPitrRetention("")).toBe("—");
    expect(formatPitrRetention("garbage")).toBe("garbage");
    expect(formatPitrRetention("604800s")).toBe("7 days");
    expect(formatPitrRetention("3600s")).toBe("1 hours");
  });
  it("bigQuerySchemaToRows", () => {
    expect(bigQuerySchemaToRows("not json")).toEqual([]);
    expect(bigQuerySchemaToRows(JSON.stringify({ not: "array" }))).toEqual([]);
    const rows = bigQuerySchemaToRows(
      JSON.stringify([
        { name: "id", type: "INTEGER", mode: "REQUIRED" },
        {
          name: "addr",
          type: "RECORD",
          fields: [{ name: "city", type: "STRING" }],
        },
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.cells.name).toBe("id");
    expect(rows[1]!.depth).toBe(0);
    expect(rows[2]!.depth).toBe(1);
    expect(rows[2]!.cells.mode).toBe("NULLABLE");
  });
});

describe("pricing", () => {
  it("regionFromZone strips zone suffix", () => {
    expect(regionFromZone("us-central1-a")).toBe("us-central1");
    expect(regionFromZone("us-central1")).toBe("us-central1");
  });
  it("geoFromRegion", () => {
    expect(geoFromRegion("us-central1")).toBe("Americas");
    expect(geoFromRegion("northamerica-northeast1")).toBe("Americas");
    expect(geoFromRegion("southamerica-east1")).toBe("Americas");
    expect(geoFromRegion("asia-east1")).toBe("APAC");
    expect(geoFromRegion("australia-southeast1")).toBe("APAC");
    expect(geoFromRegion("europe-west1")).toBe("EMEA");
  });
  it("estimateMachineTypeMonthlyPrices computes from family rates", () => {
    const rates: PricingRates = {
      machineRates: { e2: { corePerHourUsd: 0.02, ramPerGiBHourUsd: 0.01 } },
      diskGbMonthUsd: { "pd-balanced": 0.1 },
    };
    const out = estimateMachineTypeMonthlyPrices(
      [
        { id: "e2-medium", vcpus: 2, memoryMb: 4096 },
        { id: "unknown-family", vcpus: 1, memoryMb: 1024 },
      ],
      rates,
    );
    // (2*0.02 + 4*0.01) * 730 = (0.04 + 0.04) * 730 = 58.4
    expect(out["e2-medium"]).toBeCloseTo(58.4, 1);
    expect(out["unknown-family"]).toBeUndefined();
  });
  it("estimateMachineTypeMonthlyPrices handles n2d family + zero hourly", () => {
    const rates: PricingRates = {
      machineRates: { n2d: { corePerHourUsd: 0, ramPerGiBHourUsd: 0 } },
      diskGbMonthUsd: {},
    };
    const out = estimateMachineTypeMonthlyPrices(
      [{ id: "n2d-standard-2", vcpus: 2, memoryMb: 0 }],
      rates,
    );
    expect(out["n2d-standard-2"]).toBeUndefined();
  });
});

describe("cloudsql-engine", () => {
  it("engineInfoFromVersion", () => {
    expect(engineInfoFromVersion("MYSQL_8_0").scheme).toBe("mysql");
    expect(engineInfoFromVersion("SQLSERVER_2019").username).toBe("sqlserver");
    expect(engineInfoFromVersion("POSTGRES_15").port).toBe("5432");
  });
  it("buildConnectionUrl", () => {
    expect(buildConnectionUrl("POSTGRES_15", "", "pw")).toBe("");
    expect(buildConnectionUrl("POSTGRES_15", "1.2.3.4", "p@ss")).toBe(
      "postgres://postgres:p%40ss@1.2.3.4:5432/postgres",
    );
    expect(buildConnectionUrl("MYSQL_8_0", "1.2.3.4", "pw")).toBe("mysql://root:pw@1.2.3.4:3306");
    expect(buildConnectionUrl("SQLSERVER_2019", "1.2.3.4", "pw")).toContain(
      "?encrypt=true&trustServerCertificate=true",
    );
  });
});

describe("regions", () => {
  it("regionOption with known + unknown region", () => {
    const known = regionOption("us-central1-a", "Zone A");
    expect(known.id).toBe("us-central1-a");
    expect(known.label).toBe("Zone A");
    expect(known.location).toBe("Iowa, USA");
    const unknown = regionOption("nowhere-1");
    expect(unknown.label).toBe("nowhere-1");
    expect(unknown.location).toBeUndefined();
  });
  it("exports populated catalogs", () => {
    expect(GCP_REGIONS.length).toBeGreaterThan(5);
    expect(PUBLIC_IMAGES.some((i) => i.family === "debian-12")).toBe(true);
    expect(CLOUD_BUILD_REGIONS).toContain("global");
  });
});

describe("parseBigQueryDatasetExternalId", () => {
  it("parses dataset id", () => {
    expect(parseBigQueryDatasetExternalId("acct:bigquery-dataset:proj:ds")).toEqual({
      project: "proj",
      datasetId: "ds",
    });
  });
  it("parses dataset id from table externalId", () => {
    expect(parseBigQueryDatasetExternalId("acct:bigquery-table:proj:ds/tbl")).toEqual({
      project: "proj",
      datasetId: "ds",
    });
  });
  it("throws on malformed", () => {
    expect(() => parseBigQueryDatasetExternalId("acct:bigquery-dataset:proj")).toThrow(/malformed/);
  });
});
