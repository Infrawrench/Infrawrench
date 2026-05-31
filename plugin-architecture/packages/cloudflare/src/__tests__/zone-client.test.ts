import { describe, it, expect, vi } from "vitest";
import {
  listZones,
  getZone,
  createZone,
  deleteZone,
  setDnssec,
  purgeCacheEverything,
  getZoneManifest,
  applyZoneManifest,
} from "../clients/zone-client.js";
import { makeApi } from "./_helpers.js";

const ZONE = {
  id: "z1",
  name: "a.com",
  status: "active",
  plan: { name: "Pro" },
  name_servers: ["ns1.cf.com", "ns2.cf.com"],
  type: "full",
  paused: false,
  account: { id: "acct-cf" },
  created_on: "2020-01-01",
  modified_on: "2020-02-01",
};

function zoneApi(over: Record<string, unknown> = {}) {
  const zones = {
    get: vi.fn(async () => ZONE),
    create: vi.fn(async () => ({ ...ZONE, id: "z2", name: "b.com" })),
    delete: vi.fn(async () => undefined),
    settings: { edit: vi.fn(async () => undefined) },
  };
  return makeApi({
    listZones: vi.fn(async () => [ZONE]),
    cf: {
      zones,
      dns: { dnssec: { edit: vi.fn(async () => undefined) } },
      cache: { purge: vi.fn(async () => undefined) },
      get: vi.fn(async () => ({ result: [{ id: "ssl", value: "full", editable: true }] })),
    },
    ...over,
  });
}

describe("zone-client", () => {
  it("listZones maps zones and joins nameservers", async () => {
    const api = zoneApi();
    const out = await listZones(api, "acct");
    expect(out[0]!.id).toBe("acct:zone:z1");
    expect(out[0]!.fields.nameservers).toBe("ns1.cf.com, ns2.cf.com");
    expect(out[0]!.fields.plan).toBe("Pro");
    expect(out[0]!.resolvedOutputs.zoneId).toBe("z1");
  });

  it("getZone fetches one zone", async () => {
    const api = zoneApi();
    const out = await getZone(api, "z1", "acct");
    expect(api.cf.zones.get).toHaveBeenCalledWith({ zone_id: "z1" });
    expect(out.externalId).toBe("z1");
  });

  it("createZone creates with the resolved account id", async () => {
    const api = zoneApi();
    const out = await createZone(api, "acct", { name: "b.com" });
    expect(api.cf.zones.create).toHaveBeenCalledWith({
      account: { id: "acct-cf" },
      name: "b.com",
      type: "full",
    });
    expect(out.displayName).toBe("b.com");
  });

  it("deleteZone calls SDK delete", async () => {
    const api = zoneApi();
    await deleteZone(api, "z1");
    expect(api.cf.zones.delete).toHaveBeenCalledWith({ zone_id: "z1" });
  });

  it("setDnssec enables and disables", async () => {
    const api = zoneApi();
    await setDnssec(api, "z1", true);
    expect(api.cf.dns.dnssec.edit).toHaveBeenCalledWith({ zone_id: "z1", status: "active" });
    await setDnssec(api, "z1", false);
    expect(api.cf.dns.dnssec.edit).toHaveBeenCalledWith({ zone_id: "z1", status: "disabled" });
  });

  it("purgeCacheEverything purges all", async () => {
    const api = zoneApi();
    await purgeCacheEverything(api, "z1");
    expect(api.cf.cache.purge).toHaveBeenCalledWith({ zone_id: "z1", purge_everything: true });
  });

  it("getZoneManifest builds setting descriptors from the result envelope", async () => {
    const api = zoneApi();
    const json = JSON.parse(await getZoneManifest(api, "z1")) as { settings: unknown[] };
    expect(Array.isArray(json.settings)).toBe(true);
    expect(json.settings.length).toBeGreaterThan(0);
  });

  it("getZoneManifest accepts a bare array response", async () => {
    const api = zoneApi({
      cf: {
        zones: { settings: { edit: vi.fn() } },
        get: vi.fn(async () => [{ id: "ssl", value: "full", editable: true }]),
      },
    });
    const json = JSON.parse(await getZoneManifest(api, "z1")) as { settings: unknown[] };
    expect(json.settings.length).toBe(1);
  });

  it("getZoneManifest falls back to empty list for unknown shape", async () => {
    const api = zoneApi({
      cf: { zones: { settings: { edit: vi.fn() } }, get: vi.fn(async () => ({ foo: "bar" })) },
    });
    const json = JSON.parse(await getZoneManifest(api, "z1")) as { settings: unknown[] };
    expect(json.settings).toEqual([]);
  });

  it("applyZoneManifest edits each changed setting", async () => {
    const api = zoneApi();
    await applyZoneManifest(api, "z1", JSON.stringify([{ id: "ssl", value: "strict" }]));
    expect(api.cf.zones.settings.edit).toHaveBeenCalledWith(
      "ssl",
      expect.objectContaining({ zone_id: "z1", value: "strict" }),
    );
  });

  it("applyZoneManifest throws when the payload is not an array", async () => {
    await expect(applyZoneManifest(zoneApi(), "z1", JSON.stringify({ id: "x" }))).rejects.toThrow(
      /must be an array/,
    );
  });
});
