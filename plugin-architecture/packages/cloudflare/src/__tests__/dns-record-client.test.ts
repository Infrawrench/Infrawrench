import { describe, it, expect, vi } from "vitest";
import {
  listAllDnsRecords,
  listDnsRecordsForZone,
  getDnsRecord,
  createDnsRecord,
  updateDnsRecord,
  deleteDnsRecord,
} from "../clients/dns-record-client.js";
import type { CloudflareApi } from "../clients/shared.js";

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}

const RECORD = {
  id: "rec1",
  type: "A",
  name: "www.a.com",
  content: "1.2.3.4",
  ttl: 300,
  proxied: true,
  zone_name: "a.com",
  comment: "primary",
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

function makeApi(over: Partial<Record<string, unknown>> = {}): CloudflareApi {
  const records = {
    list: vi.fn(() => asyncIter([RECORD])),
    get: vi.fn(async () => RECORD),
    create: vi.fn(async () => RECORD),
    edit: vi.fn(async () => RECORD),
    delete: vi.fn(async () => undefined),
  };
  return {
    listZones: vi.fn(async () => [{ id: "z1", name: "a.com" }]),
    cf: { dns: { records } },
    ...over,
  } as unknown as CloudflareApi;
}

describe("dns-record-client", () => {
  it("listAllDnsRecords maps records across zones with full id/parent", async () => {
    const api = makeApi();
    const out = await listAllDnsRecords(api, "acct");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("acct:dns-record:z1/rec1");
    expect(out[0].parentResourceId).toBe("acct:zone:z1");
    expect(out[0].accountId).toBe("acct");
    expect(out[0].displayName).toBe("A www.a.com");
    expect(out[0].fields.content).toBe("1.2.3.4");
    expect(out[0].fields.proxied).toBe(true);
    expect(out[0].fields.comment).toBe("primary");
  });

  it("listDnsRecordsForZone lists a single zone", async () => {
    const api = makeApi();
    const out = await listDnsRecordsForZone(api, "z9", "acct");
    expect(api.cf.dns.records.list).toHaveBeenCalledWith({ zone_id: "z9" });
    expect(out[0].id).toBe("acct:dns-record:z9/rec1");
  });

  it("getDnsRecord parses the composite external id", async () => {
    const api = makeApi();
    const out = await getDnsRecord(api, "z1/rec1", "acct");
    expect(api.cf.dns.records.get).toHaveBeenCalledWith("rec1", { zone_id: "z1" });
    expect(out.externalId).toBe("z1/rec1");
  });

  it("getDnsRecord throws on a malformed id", async () => {
    await expect(getDnsRecord(makeApi(), "bad", "acct")).rejects.toThrow("Invalid DNS record ID");
  });

  it("createDnsRecord builds a body and uses parent zone fallback", async () => {
    const api = makeApi();
    await createDnsRecord(
      api,
      "acct",
      { type: "A", name: "x", content: "1.1.1.1", ttl: "120", proxied: "true", priority: "10" },
      "zParent",
    );
    expect(api.cf.dns.records.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: "zParent",
        type: "A",
        ttl: 120,
        proxied: true,
        priority: 10,
      }),
    );
  });

  it("createDnsRecord throws without a zone", async () => {
    await expect(createDnsRecord(makeApi(), "acct", { type: "A" }, "")).rejects.toThrow(
      /zoneId is required/,
    );
  });

  it("updateDnsRecord sends only supplied keys", async () => {
    const api = makeApi();
    await updateDnsRecord(api, "z1/rec1", "acct", { content: "9.9.9.9", proxied: "false" });
    expect(api.cf.dns.records.edit).toHaveBeenCalledWith(
      "rec1",
      expect.objectContaining({ zone_id: "z1", content: "9.9.9.9", proxied: false }),
    );
  });

  it("updateDnsRecord throws on a malformed id", async () => {
    await expect(updateDnsRecord(makeApi(), "bad", "acct", {})).rejects.toThrow(
      "Invalid DNS record ID",
    );
  });

  it("deleteDnsRecord calls the SDK delete", async () => {
    const api = makeApi();
    await deleteDnsRecord(api, "z1/rec1");
    expect(api.cf.dns.records.delete).toHaveBeenCalledWith("rec1", { zone_id: "z1" });
  });

  it("deleteDnsRecord throws on a malformed id", async () => {
    await expect(deleteDnsRecord(makeApi(), "bad")).rejects.toThrow("Invalid DNS record ID");
  });
});
