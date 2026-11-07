import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCreateConfig } from "../create.js";
import { fetchLinodeCostData } from "../cost-data.js";
import { listVolumes } from "../listers.js";
import type { PriceCatalog } from "../pricing.js";
import { createPriceCatalogCache } from "../pricing.js";
import { fakeApi, page } from "./fake-linode.js";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the global fetch must not be reached");
  });
});
afterEach(() => vi.unstubAllGlobals());

const volume = (id: number) => ({ id, label: `v${id}` });

describe("a Linode list", () => {
  it("reads every page the response reports, at the largest page size", async () => {
    const { api, calls } = fakeApi(({ query }) => {
      const at = Number(query.get("page"));
      return page([volume(at)], at, 3);
    });
    const rows = await listVolumes(api, "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["1", "2", "3"]);
    expect(calls.map((c) => c.query.get("page"))).toEqual(["1", "2", "3"]);
    expect(calls.every((c) => c.query.get("page_size") === "500")).toBe(true);
  });

  it("runs on past an empty page while the response reports more", async () => {
    const { api } = fakeApi(({ query }) => {
      const at = Number(query.get("page"));
      return page(at === 2 ? [] : [volume(at)], at, 3);
    });
    const rows = await listVolumes(api, "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["1", "3"]);
  });

  it("throws at the page cap rather than returning part of the list", async () => {
    const { api, calls } = fakeApi(({ query }) =>
      page([volume(Number(query.get("page")))], Number(query.get("page")), 100000),
    );
    await expect(listVolumes(api, "acct")).rejects.toThrow("has more than Infrawrench reads");
    expect(calls).toHaveLength(200);
  });

  it("throws on a first page with its list renamed", async () => {
    const { api, calls } = fakeApi(() => ({ json: { items: [], page: 1, pages: 1 } }));
    await expect(listVolumes(api, "acct")).rejects.toThrow("is not a list");
    expect(calls).toHaveLength(1);
  });

  it("throws on a later page with its list renamed", async () => {
    const { api } = fakeApi(({ query }) =>
      query.get("page") === "1" ? page([volume(1)], 1, 2) : { json: { items: [], pages: 2 } },
    );
    await expect(listVolumes(api, "acct")).rejects.toThrow("is not a list");
  });

  it("throws on a 2xx with no body rather than reading it as no rows", async () => {
    const { api } = fakeApi(() => ({ text: "" }));
    await expect(listVolumes(api, "acct")).rejects.toThrow("is not a list");
  });

  it("reads a null list as empty, as a nil slice is written", async () => {
    const { api } = fakeApi(() => ({ json: { data: null, page: 1, pages: 1 } }));
    await expect(listVolumes(api, "acct")).resolves.toEqual([]);
  });
});

describe("reads where part of a list is fine", () => {
  it("still offers a picker's options from a list past the cap", async () => {
    const { api } = fakeApi(({ query }) => {
      const at = Number(query.get("page"));
      return page([{ id: at, domain: `d${at}.test` }], at, 100000);
    });
    const config = await getCreateConfig(
      { api, catalog: createPriceCatalogCache(api) },
      "domain-record",
    );
    const domainField = config.fields.find((f) => f.key === "domainId");
    expect(domainField?.options).toHaveLength(200);
  });
});

describe("fetchLinodeCostData", () => {
  const catalog: PriceCatalog = {
    linodeTypes: [],
    volumeTypes: [],
    nodeBalancerTypes: [],
    lkeTypes: [],
    objectStorageTypes: [],
    transferPrices: [],
    reservedIpTypes: [],
    databaseTypes: [],
  };

  it("throws when the newest invoice read is not a list, rather than finding no invoices", async () => {
    let invoiceReads = 0;
    const { api } = fakeApi(({ path }) => {
      if (path !== "/account/invoices") return undefined;
      invoiceReads += 1;
      return invoiceReads === 1 ? page([]) : { json: { invoices: [] } };
    });
    await expect(
      fetchLinodeCostData(
        { api, catalog: async () => catalog, now: () => Date.parse("2026-10-03T00:00:00Z") },
        { fromDate: "2026-09-01", toDate: "2026-09-30" },
      ),
    ).rejects.toThrow("is not a list");
  });
});
