import { describe, expect, it } from "vitest";
import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { fetchHetznerCostData, type HetznerCostContext } from "../cost-data.js";
import { parseDecimal, toNumber } from "../pricing.js";

/**
 * A rate card shaped like the real `/pricing` body: every price a decimal
 * string, paired `{net, gross}` with gross = net × 1.19.
 */
const PRICING = {
  pricing: {
    currency: "EUR",
    vat_rate: "19.00",
    server_backup: { percentage: "20" },
    volume: { price_per_gb_month: { net: "0.0440", gross: "0.052360" } },
    image: { price_per_gb_month: { net: "0.0122", gross: "0.014518" } },
    server_types: [
      {
        id: 22,
        name: "cx22",
        prices: [
          {
            location: "fsn1",
            price_hourly: { net: "0.0060", gross: "0.007140" },
            price_monthly: { net: "3.7900", gross: "4.510100" },
            // 20 TB as Hetzner counts it: 20 × 2^40 bytes.
            included_traffic: 21990232555520,
            price_per_tb_traffic: { net: "1.0000", gross: "1.190000" },
          },
        ],
      },
    ],
    load_balancer_types: [
      {
        id: 1,
        name: "lb11",
        prices: [
          {
            location: "fsn1",
            price_hourly: { net: "0.0090", gross: "0.010710" },
            price_monthly: { net: "5.8300", gross: "6.937700" },
            included_traffic: 21990232555520,
            price_per_tb_traffic: { net: "1.0000", gross: "1.190000" },
          },
        ],
      },
    ],
    primary_ips: [
      {
        type: "ipv4",
        prices: [
          {
            location: "fsn1",
            price_hourly: { net: "0.0008", gross: "0.000952" },
            price_monthly: { net: "0.5000", gross: "0.595000" },
          },
        ],
      },
      {
        type: "ipv6",
        prices: [
          {
            location: "fsn1",
            price_hourly: { net: "0.0000", gross: "0.000000" },
            price_monthly: { net: "0.0000", gross: "0.000000" },
          },
        ],
      },
    ],
    floating_ips: [
      {
        type: "ipv4",
        prices: [{ location: "fsn1", price_monthly: { net: "3.2900", gross: "3.915100" } }],
      },
    ],
    // Deprecated since 2024-08-29; only consulted when `floating_ips` has no
    // entry for the location.
    floating_ip: { price_monthly: { net: "1.1900", gross: "1.416100" } },
  },
};

const TIB = 1024 ** 4;

type Inventory = Partial<Record<string, unknown[]>>;

function makeContext(now: string, inventory: Inventory = {}) {
  const paths: string[] = [];
  const ctx: HetznerCostContext = {
    now: new Date(now),
    async fetch<T>(path: string): Promise<T> {
      paths.push(path);
      if (path === "/pricing") return PRICING as T;
      throw new Error(`unexpected fetch ${path}`);
    },
    async fetchAll<T>(path: string): Promise<T[]> {
      paths.push(path);
      return (inventory[path] ?? []) as T[];
    },
  };
  return { ctx, paths };
}

/** The range the host asks for on an incremental run of the current month. */
function currentMonthRange(today: string): CostFetchRange {
  return { fromDate: `${today.slice(0, 7)}-01`, toDate: today };
}

function server(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    name: "web-1",
    status: "running",
    created: "2026-05-01T00:00:00+00:00",
    server_type: { name: "cx22" },
    datacenter: { name: "fsn1-dc14", location: { name: "fsn1" } },
    backup_window: null,
    outgoing_traffic: 1_000_000,
    included_traffic: 21990232555520,
    ...overrides,
  };
}

function find(rows: CostRow[], service: string): CostRow | undefined {
  return rows.find((row) => row.service === service);
}

describe("fetchHetznerCostData", () => {
  it("prices a day of a server at its hourly rate while under the monthly cap", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z", { "/servers": [server()] });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));
    const row = find(rows, "Server");

    // 24h × €0.0060. Exact, not 0.14400000000000002.
    expect(row).toMatchObject({
      date: "2026-08-08",
      service: "Server",
      region: "fsn1",
      resourceId: "101",
      currency: "EUR",
      amount: 0.144,
    });
  });

  it("bills only up to the monthly cap on the day the cap binds", async () => {
    // By 2026-08-27 the server has existed 624h into the period: 624 × 0.0060
    // = €3.744, and one more day would reach €3.888 — past the €3.79 cap. Only
    // the remaining €0.046 is billable.
    const { ctx } = makeContext("2026-08-27T09:00:00Z", { "/servers": [server()] });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-27"));

    // In float, 3.79 - 3.744 is 0.04600000000000026. Decimal arithmetic is the
    // whole point of `pricing.ts`, so assert the exact value.
    expect(find(rows, "Server")?.amount).toBe(0.046);
  });

  it("bills nothing further once the monthly cap is reached", async () => {
    const { ctx } = makeContext("2026-08-28T09:00:00Z", { "/servers": [server()] });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-28"));

    expect(find(rows, "Server")).toBeUndefined();
  });

  it("sums a full month of daily rows to exactly the monthly cap", async () => {
    let total = 0;
    for (let day = 1; day <= 31; day++) {
      const today = `2026-08-${String(day).padStart(2, "0")}`;
      const { ctx } = makeContext(`${today}T12:00:00Z`, { "/servers": [server()] });
      const rows = await fetchHetznerCostData(ctx, currentMonthRange(today));
      total += find(rows, "Server")?.amount ?? 0;
    }

    expect(total).toBeCloseTo(3.79, 10);
  });

  it("bills a powered-off server in full", async () => {
    // Hetzner allocates a server's resources regardless of power state and
    // charges for as long as it exists, so `status: "off"` changes nothing.
    const { ctx } = makeContext("2026-08-08T12:00:00Z", {
      "/servers": [server({ status: "off" })],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    expect(find(rows, "Server")?.amount).toBe(0.144);
  });

  it("prorates a server created part-way through the run day", async () => {
    const { ctx } = makeContext("2026-08-08T18:00:00Z", {
      "/servers": [server({ created: "2026-08-08T06:00:00+00:00" })],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    // 06:00 → end of day is 18h × €0.0060.
    expect(find(rows, "Server")?.amount).toBe(0.108);
  });

  it("adds backups as a percentage uplift on the server's own price", async () => {
    // `backup_window` is non-null exactly when backups are enabled, and the
    // rate card gives 20% — of the server price, not an absolute rate.
    const { ctx } = makeContext("2026-08-08T12:00:00Z", {
      "/servers": [server({ backup_window: "22-02" })],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    expect(find(rows, "Server")?.amount).toBe(0.144);
    expect(find(rows, "Server Backup")).toMatchObject({
      date: "2026-08-08",
      region: "fsn1",
      resourceId: "101",
      amount: 0.0288, // 20% of 0.144, exactly.
    });
  });

  it("omits a backup row when backups are off", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z", { "/servers": [server()] });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    expect(find(rows, "Server Backup")).toBeUndefined();
  });

  it("prices outgoing traffic past the allowance and dates it to the period start", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z", {
      "/servers": [server({ outgoing_traffic: 21990232555520 + 2 * TIB })],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    // The counters are cumulative over the billing period and reset with it,
    // so the row is dated to the period's first day and restated in place —
    // writing the running total to each day would sum to many times the real
    // overage.
    expect(find(rows, "Traffic")).toMatchObject({
      date: "2026-08-01",
      service: "Traffic",
      region: "fsn1",
      resourceId: "101",
      currency: "EUR",
      amount: 2,
      usageAmount: 2,
      usageUnit: "TB",
    });
  });

  it("emits no traffic row while inside the included allowance", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z", {
      "/servers": [server({ outgoing_traffic: 21990232555520 })],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    expect(find(rows, "Traffic")).toBeUndefined();
  });

  it("prices volumes, IPs, load balancers and snapshots", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z", {
      "/volumes": [
        { id: 201, size: 40, created: "2026-01-01T00:00:00+00:00", location: { name: "fsn1" } },
      ],
      "/load_balancers": [
        {
          id: 301,
          created: "2026-01-01T00:00:00+00:00",
          load_balancer_type: { name: "lb11" },
          location: { name: "fsn1" },
          outgoing_traffic: 0,
          included_traffic: 21990232555520,
        },
      ],
      "/primary_ips": [
        {
          id: 401,
          type: "ipv4",
          created: "2026-01-01T00:00:00+00:00",
          location: { name: "fsn1" },
        },
        // IPv6 primary IPs are free: a zero rate must not produce a row.
        {
          id: 402,
          type: "ipv6",
          created: "2026-01-01T00:00:00+00:00",
          location: { name: "fsn1" },
        },
      ],
      "/floating_ips": [
        {
          id: 501,
          type: "ipv4",
          created: "2026-01-01T00:00:00+00:00",
          home_location: { name: "fsn1" },
        },
      ],
      "/images?type=snapshot": [
        { id: 601, type: "snapshot", created: "2026-01-01T00:00:00+00:00", image_size: 12.5 },
      ],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    // 40 GB × €0.0440/GB-month ÷ 31 days.
    expect(find(rows, "Volume")).toMatchObject({ resourceId: "201", amount: 0.056774193548 });
    // 24h × €0.0090, well under the €5.83 cap.
    expect(find(rows, "Load Balancer")).toMatchObject({ resourceId: "301", amount: 0.216 });
    // 24h × €0.0008.
    expect(find(rows, "Primary IP")).toMatchObject({ resourceId: "401", amount: 0.0192 });
    expect(rows.filter((r) => r.service === "Primary IP")).toHaveLength(1);
    // €3.29/month ÷ 31 days.
    expect(find(rows, "Floating IP")).toMatchObject({ resourceId: "501", amount: 0.106129032258 });
    // 12.5 GB × €0.0122/GB-month ÷ 31 days. Snapshots have no location.
    expect(find(rows, "Snapshot")).toMatchObject({
      resourceId: "601",
      amount: 0.004919354839,
      usageAmount: 12.5,
      usageUnit: "GB",
    });
    expect(find(rows, "Snapshot")?.region).toBeUndefined();
  });

  it("falls back to the deprecated floating_ip price when the location is unlisted", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z", {
      "/floating_ips": [
        {
          id: 502,
          type: "ipv4",
          created: "2026-01-01T00:00:00+00:00",
          home_location: { name: "sin" },
        },
      ],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    // €1.19/month ÷ 31 days.
    expect(find(rows, "Floating IP")).toMatchObject({ region: "sin", amount: 0.038387096774 });
  });

  it("skips resources whose type or location is absent from the rate card", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z", {
      "/servers": [server({ id: 102, server_type: { name: "ccx99" } }), server({ id: 103 })],
    });

    const rows = await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"));

    expect(rows.filter((r) => r.service === "Server").map((r) => r.resourceId)).toEqual(["103"]);
  });

  it("returns nothing for an empty project", async () => {
    const { ctx } = makeContext("2026-08-08T12:00:00Z");

    expect(await fetchHetznerCostData(ctx, currentMonthRange("2026-08-08"))).toEqual([]);
  });

  it("never fabricates history for a range that predates the run day", async () => {
    // The host chunks its restatement window by month. A chunk holding neither
    // today nor the current period start describes days this collector cannot
    // honestly price, so it returns nothing — and issues no requests at all.
    const { ctx, paths } = makeContext("2026-08-08T12:00:00Z", { "/servers": [server()] });

    const rows = await fetchHetznerCostData(ctx, { fromDate: "2026-07-08", toDate: "2026-07-31" });

    expect(rows).toEqual([]);
    expect(paths).toEqual([]);
  });

  it("reproduces identical rows when the same day is collected twice", async () => {
    const inventory: Inventory = {
      "/servers": [server({ backup_window: "22-02", outgoing_traffic: 21990232555520 + TIB })],
      "/volumes": [
        { id: 201, size: 40, created: "2026-01-01T00:00:00+00:00", location: { name: "fsn1" } },
      ],
    };
    const range = currentMonthRange("2026-08-08");

    const first = await fetchHetznerCostData(
      makeContext("2026-08-08T04:00:00Z", inventory).ctx,
      range,
    );
    const second = await fetchHetznerCostData(
      makeContext("2026-08-08T23:30:00Z", inventory).ctx,
      range,
    );

    // Same dimension tuple *and* same amount: the host's ReplacingMergeTree key
    // is (day, service, region, resource, currency), so a re-run must replace
    // its own rows rather than append near-duplicates.
    expect(second).toEqual(first);
    expect(
      new Set(first.map((r) => `${r.date}|${r.service}|${r.region}|${r.resourceId}`)).size,
    ).toBe(first.length);
  });

  it("fetches the rate card once per collection pass", async () => {
    const { ctx, paths } = makeContext("2026-08-08T12:00:00Z", { "/servers": [server()] });
    const { createRateCardCache } = await import("../pricing.js");
    const shared = { ...ctx, rateCard: createRateCardCache() };

    await fetchHetznerCostData(shared, currentMonthRange("2026-08-08"));
    await fetchHetznerCostData(shared, currentMonthRange("2026-08-08"));

    expect(paths.filter((p) => p === "/pricing")).toHaveLength(1);
  });
});

describe("decimal parsing", () => {
  it("parses decimal strings without float drift", () => {
    expect(parseDecimal("0.0060", "hourly")).toBe(6_000_000_000n);
    expect(parseDecimal("3.7900", "monthly")).toBe(3_790_000_000_000n);
    expect(parseDecimal("19.00", "vat")).toBe(19_000_000_000_000n);

    // The subtraction the monthly cap performs, which floats get wrong.
    expect(3.79 - 3.744).not.toBe(0.046);
    expect(toNumber(parseDecimal("3.79", "a") - parseDecimal("3.744", "b"))).toBe(0.046);

    // And the multiplication a day of hourly billing performs.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toNumber(parseDecimal("0.1", "a") + parseDecimal("0.2", "b"))).toBe(0.3);
  });

  it("rejects a price that is not a decimal number", () => {
    expect(() => parseDecimal("", "hourly")).toThrow(/not a decimal/);
    expect(() => parseDecimal("free", "hourly")).toThrow(/not a decimal/);
  });
});
