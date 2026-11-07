import { describe, expect, it } from "vitest";
import { fetchLinodeCostData } from "../cost-data.js";
import {
  listDomainRecords,
  listDomains,
  listLinodes,
  listLkeClusters,
  listLkePools,
  listNodeBalancers,
} from "../listers.js";
import { createPriceCatalogCache, type PriceCatalog } from "../pricing.js";
import { fakeApi, httpError, page, type FakeCall } from "./fake-linode.js";

/** A list past the page cap, whichever page is asked for. */
const endless = ({ query }: FakeCall) =>
  page([{ id: Number(query.get("page")) }], Number(query.get("page")), 100000);

describe("a node pool list", () => {
  const route = (failure: (call: FakeCall) => ReturnType<typeof page>) => (call: FakeCall) => {
    if (call.path === "/lke/clusters") return page([{ id: 1 }, { id: 2 }]);
    if (call.path === "/lke/clusters/1/pools") return failure(call);
    if (call.path === "/lke/clusters/2/pools") return page([{ id: 20, type: "g6", count: 1 }]);
    return undefined;
  };

  it("throws when one cluster's pools cannot be read, rather than losing them", async () => {
    const { api } = fakeApi(route(() => httpError(500)));
    await expect(listLkePools(api, "acct")).rejects.toThrow("500");
  });

  it("has no pools for a cluster that has gone since the list", async () => {
    const { api } = fakeApi(route(() => httpError(404)));
    const rows = await listLkePools(api, "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["2/20"]);
  });

  it("keeps the cluster, without its counts, when only its pools failed", async () => {
    const { api } = fakeApi(route(() => httpError(500)));
    const rows = await listLkeClusters(api, "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["1", "2"]);
    expect(rows[0]!.fields["poolCount"]).toBeUndefined();
    expect(rows[1]!.fields["poolCount"]).toBe(1);
  });

  it("throws from the cluster list when a pool list is cut off", async () => {
    const { api } = fakeApi(route(endless));
    await expect(listLkeClusters(api, "acct")).rejects.toThrow("has more than Infrawrench reads");
  });
});

describe("a domain record list", () => {
  const route = (failure: (call: FakeCall) => ReturnType<typeof page>) => (call: FakeCall) => {
    if (call.path === "/domains") return page([{ id: 1 }, { id: 2 }]);
    if (call.path === "/domains/1/records") return failure(call);
    if (call.path === "/domains/2/records") return page([{ id: 20, type: "A" }]);
    return undefined;
  };

  it("throws when one domain's records cannot be read, rather than losing them", async () => {
    const { api } = fakeApi(route(() => httpError(502)));
    await expect(listDomainRecords(api, "acct")).rejects.toThrow("502");
  });

  it("has no records for a domain that has gone since the list", async () => {
    const { api } = fakeApi(route(() => httpError(404)));
    const rows = await listDomainRecords(api, "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["2/20"]);
  });

  it("keeps the domain, without its count, when only its records failed", async () => {
    const { api } = fakeApi(route(() => httpError(502)));
    const rows = await listDomains(api, "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["1", "2"]);
    expect(rows[0]!.fields["recordCount"]).toBeUndefined();
  });

  it("throws from the domain list when a record list is cut off", async () => {
    const { api } = fakeApi(route(endless));
    await expect(listDomains(api, "acct")).rejects.toThrow("has more than Infrawrench reads");
  });
});

describe("a read a list depends on", () => {
  it("leaves firewall ids absent when the firewall read failed", async () => {
    const { api } = fakeApi(({ path }) => {
      if (path === "/linode/instances") return page([{ id: 1 }]);
      if (path === "/networking/firewalls") return httpError(500);
      return undefined;
    });
    const rows = await listLinodes(api, "acct");
    expect(rows[0]!.fields["firewallIds"]).toBeUndefined();
  });

  it("throws when the firewall list is cut off", async () => {
    const { api } = fakeApi((call) => {
      if (call.path === "/linode/instances") return page([{ id: 1 }]);
      if (call.path === "/networking/firewalls") return endless(call);
      return undefined;
    });
    await expect(listLinodes(api, "acct")).rejects.toThrow("has more than Infrawrench reads");
  });

  it("throws when a NodeBalancer's config list is cut off", async () => {
    const { api } = fakeApi((call) => {
      if (call.path === "/nodebalancers") return page([{ id: 1 }]);
      if (call.path === "/networking/firewalls") return page([]);
      if (call.path === "/nodebalancers/1/configs") return endless(call);
      return undefined;
    });
    await expect(listNodeBalancers(api, "acct")).rejects.toThrow("has more than Infrawrench reads");
  });
});

describe("the open period's inventory", () => {
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

  const costOf = (volumes: (call: FakeCall) => ReturnType<typeof page>) => {
    const { api } = fakeApi((call) => {
      if (call.path === "/volumes") return volumes(call);
      if (call.path === "/account") return { json: { balance_uninvoiced: 3 } };
      return page([]);
    });
    return fetchLinodeCostData(
      { api, catalog: async () => catalog, now: () => Date.parse("2026-10-03T00:00:00Z") },
      { fromDate: "2026-10-01", toDate: "2026-10-03" },
    );
  };

  it("throws on a server failure, rather than reading it as no volumes", async () => {
    await expect(costOf(() => httpError(500))).rejects.toThrow("500");
  });

  it("throws when the list is cut off", async () => {
    await expect(costOf(endless)).rejects.toThrow("has more than Infrawrench reads");
  });

  it.each([401, 403, 404])("reads a %i as nothing this token can price", async (status) => {
    const rows = await costOf(() => httpError(status));
    expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBeCloseTo(3, 6);
  });
});

describe("the price catalog", () => {
  it("throws when a price list is cut off, rather than reading it as no prices", async () => {
    const { api } = fakeApi((call) => (call.path === "/volumes/types" ? endless(call) : page([])));
    await expect(createPriceCatalogCache(api).get()).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("still answers from the prices it could read when one endpoint is down", async () => {
    const { api } = fakeApi(({ path }) =>
      path === "/volumes/types"
        ? httpError(500)
        : page(path === "/lke/types" ? [{ id: "lke" }] : []),
    );
    const prices = await createPriceCatalogCache(api).get();
    expect(prices.volumeTypes).toEqual([]);
    expect(prices.lkeTypes).toEqual([{ id: "lke" }]);
  });
});
