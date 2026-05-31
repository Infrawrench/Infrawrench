import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.fn((_opts?: unknown) => ({ id: "fake-ch-client" }));
vi.mock("@clickhouse/client", () => ({ createClient: (a: unknown) => createClient(a) }));

const CH_ENV = [
  "CLICKHOUSE_METRICS_URL",
  "CLICKHOUSE_METRICS_USER",
  "CLICKHOUSE_METRICS_PASSWORD",
  "CLICKHOUSE_METRICS_DATABASE",
] as const;

function clearChEnv() {
  for (const k of CH_ENV) delete process.env[k];
}
function setChEnv() {
  process.env["CLICKHOUSE_METRICS_URL"] = "https://ch.example.com";
  process.env["CLICKHOUSE_METRICS_USER"] = "u";
  process.env["CLICKHOUSE_METRICS_PASSWORD"] = "p";
  process.env["CLICKHOUSE_METRICS_DATABASE"] = "metrics";
}

let mod: typeof import("../clickhouse/client");

beforeEach(async () => {
  vi.clearAllMocks();
  clearChEnv();
  mod = await import("../clickhouse/client");
  mod.resetClickHouseClientForTests();
});

afterEach(() => {
  clearChEnv();
});

describe("isClickHouseConfigured", () => {
  it("is false when env vars are missing", () => {
    mod.resetClickHouseClientForTests();
    expect(mod.isClickHouseConfigured()).toBe(false);
  });

  it("is true when all four env vars are set", () => {
    setChEnv();
    mod.resetClickHouseClientForTests();
    expect(mod.isClickHouseConfigured()).toBe(true);
  });

  it("memoizes the result until reset", () => {
    mod.resetClickHouseClientForTests();
    expect(mod.isClickHouseConfigured()).toBe(false);
    setChEnv();
    // Still cached as false (no reset).
    expect(mod.isClickHouseConfigured()).toBe(false);
    mod.resetClickHouseClientForTests();
    expect(mod.isClickHouseConfigured()).toBe(true);
  });
});

describe("getClickHouseClient", () => {
  it("throws when not configured", () => {
    mod.resetClickHouseClientForTests();
    expect(() => mod.getClickHouseClient()).toThrow(/not configured/);
  });

  it("creates a client with env config and caches it", () => {
    setChEnv();
    mod.resetClickHouseClientForTests();
    const a = mod.getClickHouseClient();
    const b = mod.getClickHouseClient();
    expect(a).toBe(b);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://ch.example.com",
        username: "u",
        password: "p",
        database: "metrics",
        clickhouse_settings: { async_insert: 1, wait_for_async_insert: 0 },
      }),
    );
  });
});
