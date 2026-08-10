import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostExportRecord } from "../cost-exports/store";

/**
 * The run loop's exactly-once protocol.
 *
 * The hazard being tested is not "does an export upload" — it is what happens
 * when the *outcome write* fails after the upload has already gone out. The
 * lease lives in `next_run_at`, so an unrecorded run is re-claimed half an hour
 * later and delivered a second time; for an HTTPS endpoint that is a duplicate
 * nobody can retract. So these tests drive the database mock into failure at
 * exactly that point and assert on the number of deliveries.
 *
 * Mocked at the module boundary in the style of `metric-alert-pass.test.ts`:
 * the drizzle `db` is a capture object, and everything that would reach
 * ClickHouse or a bucket is replaced.
 */

/** Every `db.update(...).set(values)` payload, in order. */
const updates: Record<string, unknown>[] = [];
/** Decides whether a given update resolves or rejects. Reset per test. */
let updateBehaviour: (values: Record<string, unknown>) => Promise<void>;

vi.mock("../db/client", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => updateBehaviour(values) };
      },
    }),
  },
}));

vi.mock("../db/schema", () => ({ costExports: { id: "id", organizationId: "organization_id" } }));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
}));

vi.mock("../encryption", () => ({
  buildAad: (...parts: string[]) => parts.join(":"),
  encrypt: async () => ({ ciphertext: "c", iv: "i" }),
  decrypt: async () => JSON.stringify({ kind: "http", url: "https://wh.example.com/ingest?sig=x" }),
}));

vi.mock("../clickhouse/client", () => ({ isClickHouseConfigured: () => true }));

vi.mock("../clickhouse/cost-readers", () => ({
  getCostCoverage: async () => new Map([["acct-1", { lastDay: "2026-08-06" }]]),
}));

vi.mock("../cost-exports/rows", () => ({
  resolveColumns: () => ({ dimensions: [], tagColumns: [] }),
  streamCostExportRows: async function* () {
    yield { day: "2026-08-07", amount: 1, currency: "USD" };
  },
}));

vi.mock("../cost-exports/serialize", () => ({
  serializeRows: (_format: string, rows: AsyncIterable<unknown>) => ({
    contentType: "text/csv",
    body: (async function* () {
      for await (const _row of rows) yield "row\n";
    })(),
  }),
}));

const uploadCostExportObject = vi.fn(async () => ({ byteCount: 4 }));
vi.mock("../cost-exports/destinations", () => ({
  uploadCostExportObject: (...args: unknown[]) => uploadCostExportObject(...(args as [])),
  CostExportUploadError: class CostExportUploadError extends Error {},
}));

const { runCostExport } = await import("../cost-exports/run");
const { COST_EXPORT_IN_FLIGHT_PREFIX, isCostExportInFlight } =
  await import("../cost-exports/store");

/** A claimed row, as `claimDueCostExports` would hand it over. */
function exportRow(overrides: Record<string, unknown> = {}): CostExportRecord {
  return {
    id: "exp-1",
    organizationId: "org-1",
    name: "Warehouse",
    format: "csv",
    query: { version: 1, dimensions: [], tagKeys: [], filters: [] },
    cadence: "daily",
    hour: 4,
    timezone: "UTC",
    restatementDays: 0,
    enabled: true,
    destinationKind: "http",
    destination: { kind: "http", method: "POST", urlHint: "wh.example.com/…abcd" },
    encryptedCredentials: "cipher",
    credentialsIv: "iv",
    credentialHint: "wh.example.com/…abcd",
    lastRunAt: null,
    lastStatus: "succeeded",
    lastError: null,
    lastObjectCount: 1,
    lastRowCount: 10,
    nextRunAt: new Date("2026-08-08T04:30:00Z"),
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-08-08T04:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as unknown as CostExportRecord;
}

const s3Row = () =>
  exportRow({
    destinationKind: "s3",
    destination: {
      kind: "s3",
      bucket: "finance",
      prefix: "",
      region: "eu-central-1",
      endpoint: "",
      forcePathStyle: false,
    },
  });

const NOW = new Date("2026-08-08T04:00:00Z");
/** No backoff: these tests exercise the give-up path, not the waiting. */
const noRetry = { now: NOW, persistRetryDelaysMs: [] as number[] };

beforeEach(() => {
  updates.length = 0;
  uploadCostExportObject.mockClear();
  updateBehaviour = async () => {};
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("runCostExport — the happy path still behaves", () => {
  it("delivers each period and records the outcome once", async () => {
    const result = await runCostExport(exportRow(), noRetry);

    expect(result.status).toBe("succeeded");
    expect(result.error).toBeNull();
    expect(uploadCostExportObject).toHaveBeenCalledTimes(1);
    // Marker first, outcome second; the outcome clears the marker.
    expect(updates).toHaveLength(2);
    expect(isCostExportInFlight(updates[0]!["lastError"] as string)).toBe(true);
    expect(updates[1]).toMatchObject({ lastStatus: "succeeded", lastError: null });
  });

  it("does not mark an S3 export in flight — an overwrite costs nothing", async () => {
    await runCostExport(s3Row(), noRetry);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ lastStatus: "succeeded" });
  });
});

describe("runCostExport — a lost outcome write must not re-deliver", () => {
  /** Marker write succeeds, outcome write always fails. */
  function failTheOutcomeWrite() {
    updateBehaviour = async (values) => {
      if (isCostExportInFlight((values["lastError"] as string | null) ?? null)) return;
      throw new Error("connection terminated unexpectedly");
    };
  }

  it("leaves a marker, reports the failure, and refuses the second attempt", async () => {
    failTheOutcomeWrite();
    const first = await runCostExport(exportRow(), noRetry);

    expect(uploadCostExportObject).toHaveBeenCalledTimes(1);
    // The delivery happened, so the result says so — but the caller is told the
    // record of it did not land, rather than being handed a clean "succeeded".
    expect(first.status).toBe("succeeded");
    expect(first.error).toMatch(/could not be recorded/);

    const marker = updates[0]!["lastError"] as string;
    expect(marker.startsWith(COST_EXPORT_IN_FLIGHT_PREFIX)).toBe(true);

    // The lease expires and the poller claims the same row again. Its
    // `last_error` is still the marker, because nothing overwrote it.
    updates.length = 0;
    updateBehaviour = async () => {};
    const second = await runCostExport(exportRow({ lastError: marker }), noRetry);

    // The whole point: no second POST to somebody else's endpoint.
    expect(uploadCostExportObject).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/skipped/);
    expect(second.objects).toEqual([]);
    // And the skip is written where an operator will see it.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ lastStatus: "failed" });
    expect(updates[0]!["lastError"]).toMatch(/twice/);
    expect(isCostExportInFlight(updates[0]!["lastError"] as string)).toBe(false);
  });

  it("runs normally again once the skip has been recorded", async () => {
    const skipped = "A previous run of this export started delivering…";
    await runCostExport(exportRow({ lastStatus: "failed", lastError: skipped }), noRetry);
    expect(uploadCostExportObject).toHaveBeenCalledTimes(1);
  });

  it("re-runs an S3 export instead of skipping it — the key is overwritten", async () => {
    failTheOutcomeWrite();
    await runCostExport(s3Row(), noRetry);
    expect(uploadCostExportObject).toHaveBeenCalledTimes(1);

    // Nothing was marked, so the re-claim just does the run again.
    updateBehaviour = async () => {};
    await runCostExport(s3Row(), noRetry);
    expect(uploadCostExportObject).toHaveBeenCalledTimes(2);
  });

  it("aborts before delivering anything when the marker itself cannot be written", async () => {
    updateBehaviour = async (values) => {
      if (isCostExportInFlight((values["lastError"] as string | null) ?? null)) {
        throw new Error("connection terminated unexpectedly");
      }
    };

    const result = await runCostExport(exportRow(), noRetry);

    // Fail-closed: the write that failed happened before any bytes moved.
    expect(uploadCostExportObject).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(updates[1]).toMatchObject({ lastStatus: "failed" });
  });

  it("retries a transient outcome write rather than abandoning the run", async () => {
    let outcomeAttempts = 0;
    updateBehaviour = async (values) => {
      if (isCostExportInFlight((values["lastError"] as string | null) ?? null)) return;
      outcomeAttempts++;
      if (outcomeAttempts < 3) throw new Error("the database system is starting up");
    };

    const result = await runCostExport(exportRow(), { now: NOW, persistRetryDelaysMs: [1, 1, 1] });

    expect(outcomeAttempts).toBe(3);
    expect(result.status).toBe("succeeded");
    expect(result.error).toBeNull();
    expect(uploadCostExportObject).toHaveBeenCalledTimes(1);
  });
});
