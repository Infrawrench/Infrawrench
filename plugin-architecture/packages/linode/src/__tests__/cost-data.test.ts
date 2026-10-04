import { describe, expect, it } from "vitest";
import type { LinodeApi } from "../api.js";
import {
  OTHER_UNINVOICED,
  RowBuilder,
  UNINVOICED_ADJUSTMENTS,
  addInvoiceItems,
  addUninvoicedPeriod,
  daysBetween,
  fetchLinodeCostData,
  invoiceFallbackSpan,
  openPeriodStart,
} from "../cost-data.js";
import { parseInvoiceItemLabel } from "../invoice-label.js";
import type { PriceCatalog } from "../pricing.js";

const catalog: PriceCatalog = {
  linodeTypes: [
    {
      id: "g6-standard-1",
      label: "Linode 2GB",
      class: "standard",
      vcpus: 1,
      memory: 2048,
      disk: 51200,
      price: { hourly: 0.018, monthly: 12 },
      region_prices: [{ id: "br-gru", hourly: 0.025, monthly: 16.8 }],
      addons: { backups: { price: { hourly: 0.004, monthly: 2.5 }, region_prices: [] } },
    },
  ],
  volumeTypes: [{ id: "volume", price: { hourly: 0.00015, monthly: 0.1 }, region_prices: [] }],
  nodeBalancerTypes: [
    { id: "nodebalancer", price: { hourly: 0.015, monthly: 10 }, region_prices: [] },
  ],
  lkeTypes: [
    { id: "lke-sa", price: { hourly: 0, monthly: 0 } },
    { id: "lke-ha", price: { hourly: 0.09, monthly: 60 } },
  ],
  objectStorageTypes: [{ id: "objectstorage", price: { hourly: 0.0075, monthly: 5 } }],
  transferPrices: [],
  reservedIpTypes: [{ id: "reserved-ipv4", price: { hourly: 0.0068, monthly: null } }],
  databaseTypes: [],
};

describe("parseInvoiceItemLabel", () => {
  it.each([
    [
      "Linode 32GB - MyLinode (1234)",
      { service: "Linodes", plan: "Linode 32GB", resourceLabel: "MyLinode", resourceId: "1234" },
    ],
    [
      "Nanode 1GB - my-linode-1 (1)",
      { service: "Linodes", plan: "Nanode 1GB", resourceLabel: "my-linode-1", resourceId: "1" },
    ],
    [
      "Backup Service - Linode 2GB - MyLinode (1234)",
      { service: "Backups", plan: "Linode 2GB", resourceLabel: "MyLinode", resourceId: "1234" },
    ],
    ["Backup Service - Linode 8GB", { service: "Backups", plan: "Linode 8GB" }],
    [
      "Storage Volume - volume (1234) - 20 GB",
      { service: "Block Storage", resourceLabel: "volume", resourceId: "1234" },
    ],
    ["Outbound Transfer Overage", { service: "Network Transfer" }],
    [
      "NodeBalancer - web-lb (99)",
      { service: "NodeBalancers", resourceLabel: "web-lb", resourceId: "99" },
    ],
    ["Object Storage", { service: "Object Storage" }],
  ])("parses %s", (label, expected) => {
    expect(parseInvoiceItemLabel(label)).toEqual(expected);
  });

  it("files an unknown label under its leading chunk rather than dropping it", () => {
    expect(parseInvoiceItemLabel("Quantum Widgets - thing (5)").service).toBe("Quantum Widgets");
    expect(parseInvoiceItemLabel("").service).toBe("Other");
  });
});

describe("addInvoiceItems", () => {
  const range = { fromDate: "2026-09-01", toDate: "2026-09-30" };

  it("spreads an item evenly over the days it covers, with tax as its own charge type", () => {
    const b = new RowBuilder();
    addInvoiceItems(
      b,
      [
        {
          label: "Linode 2GB - web (42)",
          amount: 10,
          tax: 1,
          from: "2026-09-21T00:00:00",
          to: "2026-09-30T23:59:59",
          type: "hourly",
          quantity: 240,
          region: "us-east",
        },
      ],
      range,
      invoiceFallbackSpan("2026-10-01T00:00:00"),
    );
    const rows = b.build();
    const usage = rows.filter((r) => !r.chargeType);
    const tax = rows.filter((r) => r.chargeType === "tax");
    expect(usage).toHaveLength(10);
    expect(
      usage.every(
        (r) => r.resourceId === "42" && r.region === "us-east" && r.service === "Linodes",
      ),
    ).toBe(true);
    expect(usage.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(10, 6);
    expect(tax.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(1, 6);
    expect(usage[0]!.usageUnit).toBe("Hours");
  });

  it("sums two items that share a storage key instead of writing the key twice", () => {
    const b = new RowBuilder();
    const item = {
      label: "Storage Volume - data (7) - 10 GB",
      amount: 3,
      from: "2026-09-01T00:00:00",
      to: "2026-09-01T23:59:59",
      region: "us-east",
    };
    addInvoiceItems(b, [item, item], range, invoiceFallbackSpan("2026-10-01T00:00:00"));
    const rows = b.build();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBeCloseTo(6);
  });

  it("files negative items as credits and clips to the fetch range", () => {
    const b = new RowBuilder();
    addInvoiceItems(
      b,
      [
        {
          label: "Promotional credit",
          amount: -30,
          from: "2026-08-01T00:00:00",
          to: "2026-09-30T23:59:59",
          type: "misc",
        },
      ],
      range,
      invoiceFallbackSpan("2026-10-01T00:00:00"),
    );
    const rows = b.build();
    expect(rows.every((r) => r.chargeType === "credit")).toBe(true);
    expect(rows.every((r) => r.date >= "2026-09-01")).toBe(true);
    // 30 of the 61 covered days fall inside the range.
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo((-30 * 30) / 61, 4);
  });

  it("uses the invoice's billing month for items without a span", () => {
    const span = invoiceFallbackSpan("2026-10-01T00:00:00");
    expect(new Date(span.from).toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(new Date(span.to).toISOString().slice(0, 10)).toBe("2026-09-30");
  });
});

describe("addUninvoicedPeriod", () => {
  const periodStart = Date.parse("2026-10-01T00:00:00Z");
  const now = Date.parse("2026-10-03T12:00:00Z");
  const range = { fromDate: "2026-09-04", toDate: "2026-10-04" };
  const empty = {
    linodes: [],
    volumes: [],
    nodeBalancers: [],
    lkeClusters: [],
    databases: [],
    buckets: [],
    reservedIps: [],
  };

  it("prices inventory hourly and tops the period up to Linode's own uninvoiced total", () => {
    const b = new RowBuilder();
    addUninvoicedPeriod(b, {
      inventory: {
        ...empty,
        linodes: [
          {
            id: 42,
            type: "g6-standard-1",
            region: "us-east",
            created: "2025-01-01T00:00:00",
            backups: { enabled: true },
          },
        ],
      },
      catalog,
      balanceUninvoiced: 5,
      periodStart,
      now,
      range,
    });
    const rows = b.build();
    const linode = rows.filter((r) => r.service === "Linodes");
    const backups = rows.filter((r) => r.service === "Backups");
    const other = rows.filter((r) => r.service === OTHER_UNINVOICED);
    // 60 hours at $0.018 and $0.004.
    expect(linode.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(60 * 0.018, 6);
    expect(backups.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(60 * 0.004, 6);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(5, 4);
    expect(other).toHaveLength(3);
  });

  it("caps a resource at its monthly price", () => {
    const b = new RowBuilder();
    addUninvoicedPeriod(b, {
      inventory: {
        ...empty,
        linodes: [
          { id: 1, type: "g6-standard-1", region: "us-east", created: "2025-01-01T00:00:00" },
        ],
      },
      catalog,
      balanceUninvoiced: 12,
      periodStart,
      now: Date.parse("2026-10-31T23:00:00Z"),
      range: { fromDate: "2026-10-01", toDate: "2026-10-31" },
    });
    const linode = b.build().filter((r) => r.service === "Linodes");
    expect(linode.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(12, 6);
  });

  it("uses the regional price and starts at creation", () => {
    const b = new RowBuilder();
    addUninvoicedPeriod(b, {
      inventory: {
        ...empty,
        linodes: [
          { id: 1, type: "g6-standard-1", region: "br-gru", created: "2026-10-03T00:00:00" },
        ],
      },
      catalog,
      balanceUninvoiced: 0.3,
      periodStart,
      now,
      range,
    });
    const linode = b.build().filter((r) => r.service === "Linodes");
    expect(linode).toHaveLength(1);
    expect(linode[0]!.amount).toBeCloseTo(12 * 0.025, 6);
  });

  it("reports a total below the estimate as an adjustment, never as negative usage", () => {
    const b = new RowBuilder();
    addUninvoicedPeriod(b, {
      inventory: {
        ...empty,
        volumes: [{ id: 9, size: 100, region: "us-east", created: "2025-01-01T00:00:00" }],
      },
      catalog,
      balanceUninvoiced: 0,
      periodStart,
      now,
      range,
    });
    const adj = b.build().filter((r) => r.service === UNINVOICED_ADJUSTMENTS);
    expect(adj.length).toBeGreaterThan(0);
    expect(adj.every((r) => r.chargeType === "adjustment" && r.amount < 0)).toBe(true);
  });

  it("charges the free LKE control plane nothing and the HA one its rate", () => {
    const b = new RowBuilder();
    addUninvoicedPeriod(b, {
      inventory: {
        ...empty,
        lkeClusters: [
          {
            id: 1,
            region: "us-east",
            created: "2025-01-01T00:00:00",
            control_plane: { high_availability: false },
          },
          {
            id: 2,
            region: "us-east",
            created: "2025-01-01T00:00:00",
            control_plane: { high_availability: true },
          },
        ],
      },
      catalog,
      balanceUninvoiced: 60 * 0.09,
      periodStart,
      now,
      range,
    });
    const rows = b.build();
    expect(rows.filter((r) => r.resourceId === "1")).toHaveLength(0);
    expect(rows.filter((r) => r.resourceId === "2").reduce((s, r) => s + r.amount, 0)).toBeCloseTo(
      60 * 0.09,
      6,
    );
  });
});

describe("openPeriodStart", () => {
  const now = Date.parse("2026-10-04T10:00:00Z");
  it("starts the day after the newest invoice's last covered day", () => {
    const start = openPeriodStart(
      [{ to: "2026-09-30T23:59:59" }],
      { id: 1, date: "2026-10-01T00:00:00" },
      now,
    );
    expect(new Date(start).toISOString().slice(0, 10)).toBe("2026-10-01");
  });
  it("includes last month when its invoice has not been generated yet", () => {
    const start = openPeriodStart(
      [{ to: "2026-08-31T23:59:59" }],
      { id: 1, date: "2026-09-01T00:00:00" },
      now,
    );
    expect(new Date(start).toISOString().slice(0, 10)).toBe("2026-09-01");
  });
  it("falls back to the first of the month for an account with no invoices", () => {
    expect(new Date(openPeriodStart([], undefined, now)).toISOString().slice(0, 10)).toBe(
      "2026-10-01",
    );
  });
});

describe("daysBetween", () => {
  it("is inclusive", () => {
    expect(daysBetween("2026-09-29", "2026-10-01")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
  });
});

describe("fetchLinodeCostData", () => {
  function fakeApi(): LinodeApi {
    const invoices = [{ id: 7, date: "2026-10-01T00:00:00", total: 12 }];
    const items = [
      {
        label: "Linode 2GB - web (42)",
        amount: 12,
        tax: 0,
        from: "2026-09-01T00:00:00",
        to: "2026-09-30T23:59:59",
        region: "us-east",
        type: "hourly",
        quantity: 720,
      },
    ];
    return {
      async get<T>(path: string) {
        if (path === "/account/invoices")
          return { data: invoices, page: 1, pages: 1, results: 1 } as T;
        if (path === "/account") return { balance_uninvoiced: 1.5 } as T;
        throw new Error(`unexpected ${path}`);
      },
      async send<T>() {
        return {} as T;
      },
      async all<T>(path: string) {
        if (path === "/account/invoices") return invoices as T[];
        if (path === "/account/invoices/7/items") return items as T[];
        return [] as T[];
      },
      async monitor<T>() {
        return {} as T;
      },
    };
  }

  it("combines a closed month from its invoice with the open month from the uninvoiced balance", async () => {
    const rows = await fetchLinodeCostData(
      {
        api: fakeApi(),
        catalog: async () => catalog,
        now: () => Date.parse("2026-10-03T00:00:00Z"),
      },
      { fromDate: "2026-09-01", toDate: "2026-10-03" },
    );
    const september = rows.filter((r) => r.date < "2026-10-01");
    const october = rows.filter((r) => r.date >= "2026-10-01");
    expect(september.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(12, 6);
    expect(october.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(1.5, 6);
    expect(october.every((r) => r.service === OTHER_UNINVOICED)).toBe(true);
  });
});
