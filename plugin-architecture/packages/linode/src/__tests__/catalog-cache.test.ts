import { describe, expect, it } from "vitest";
import { createPriceCatalogCache } from "../pricing.js";
import { fakeApi, httpError, page } from "./fake-linode.js";

describe("the price catalog cache", () => {
  it("reads again after a load where one endpoint failed", async () => {
    let up = false;
    const { api } = fakeApi(({ path }) => {
      if (path === "/linode/types") return up ? page([{ id: "g6" }]) : httpError(503);
      return page([]);
    });
    const cache = createPriceCatalogCache(api);
    expect((await cache.get()).linodeTypes).toEqual([]);
    up = true;
    expect((await cache.get()).linodeTypes).toEqual([{ id: "g6" }]);
  });

  it("keeps a load where every endpoint answered", async () => {
    const { api, calls } = fakeApi(() => page([]));
    const cache = createPriceCatalogCache(api);
    await cache.get();
    const after = calls.length;
    await cache.get();
    expect(calls).toHaveLength(after);
  });
});
