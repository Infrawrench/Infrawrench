import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app policy store. What matters: a stored row is read leniently (an id
 * this build does not know, a duplicate or an always-on app never turns
 * anything off it should not), and a write is strict, so the settings page
 * and the API cannot save a policy that names something else.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { disabledProducts, parseDisabledProducts, setDisabledProducts, ProductSettingsError } =
  await import("../products/settings");

const ORG = "org1";

function upsert() {
  return pg.queries.find((q) => q.sql.startsWith('insert into "org_product_settings"'));
}

beforeEach(() => {
  pg.reset();
});

describe("disabledProducts", () => {
  it("turns nothing off for an organization that never saved", async () => {
    expect(await disabledProducts(ORG)).toEqual([]);
  });

  it("returns the stored apps in the canonical order, once each", async () => {
    pg.setRows([{ disabledProducts: ["automation", "costs", "costs"] }]);
    expect(await disabledProducts(ORG)).toEqual(["costs", "automation"]);
  });

  it("ignores an unknown id and an always-on app in a stored row", async () => {
    pg.setRows([{ disabledProducts: ["infrastructure", "not-an-app", "security"] }]);
    expect(await disabledProducts(ORG)).toEqual(["security"]);
  });

  it("reads a row that is not a list as nothing turned off", async () => {
    pg.setRows([{ disabledProducts: { costs: true } }]);
    expect(await disabledProducts(ORG)).toEqual([]);
  });
});

describe("parseDisabledProducts", () => {
  it("accepts every switchable app and orders them", () => {
    expect(parseDisabledProducts(["delivery", "costs"])).toEqual(["costs", "delivery"]);
    expect(parseDisabledProducts([])).toEqual([]);
  });

  it("refuses an unknown app", () => {
    expect(() => parseDisabledProducts(["costs", "billing"])).toThrow(ProductSettingsError);
    expect(() => parseDisabledProducts(["billing"])).toThrow(/Unknown app: billing/);
    expect(() => parseDisabledProducts([7])).toThrow(ProductSettingsError);
  });

  it("refuses an always-on app", () => {
    expect(() => parseDisabledProducts(["infrastructure"])).toThrow(/cannot be turned off/);
  });

  it("refuses anything but a list", () => {
    expect(() => parseDisabledProducts("costs")).toThrow(ProductSettingsError);
  });
});

describe("setDisabledProducts", () => {
  it("upserts the normalized list and returns what was stored", async () => {
    pg.queueRows([{ disabledProducts: ["costs", "security"] }]);
    expect(await setDisabledProducts(ORG, ["security", "costs", "costs"])).toEqual([
      "costs",
      "security",
    ]);
    const insert = upsert();
    expect(insert?.sql).toContain('on conflict ("organization_id") do update set');
    expect(insert?.params[0]).toBe(ORG);
    expect(JSON.parse(String(insert?.params[1]))).toEqual(["costs", "security"]);
  });

  it("writes nothing for a refused policy", async () => {
    await expect(setDisabledProducts(ORG, ["infrastructure"])).rejects.toThrow(
      ProductSettingsError,
    );
    await expect(setDisabledProducts(ORG, ["nope"])).rejects.toThrow(ProductSettingsError);
    expect(upsert()).toBeUndefined();
  });
});
