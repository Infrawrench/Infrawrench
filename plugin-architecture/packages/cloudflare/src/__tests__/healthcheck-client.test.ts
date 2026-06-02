import { describe, it, expect, vi, type Mock } from "vitest";
import {
  listAllHealthchecks,
  createHealthcheck,
  editHealthcheck,
  deleteHealthcheck,
} from "../clients/healthcheck-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const HC = {
  id: "hc1",
  name: "origin",
  address: "1.2.3.4",
  type: "HTTPS",
  status: "healthy",
  interval: 60,
  timeout: 5,
  retries: 2,
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

function hcApi(over: Record<string, unknown> = {}) {
  const healthchecks = {
    list: vi.fn(() => asyncIter([HC])),
    create: vi.fn(async () => HC),
    edit: vi.fn(async () => HC),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { healthchecks }, ...over });
}

describe("healthcheck-client", () => {
  it("listAllHealthchecks maps across zones", async () => {
    const api = hcApi();
    const out = await listAllHealthchecks(api, "acct");
    expect(out[0]!.id).toBe("acct:healthcheck:z1/hc1");
    expect(out[0]!.fields.address).toBe("1.2.3.4");
    expect(out[0]!.fields.interval).toBe(60);
  });

  it("createHealthcheck builds http_config for HTTPS", async () => {
    const api = hcApi();
    await createHealthcheck(
      api,
      "acct",
      {
        name: "origin",
        address: "1.2.3.4",
        type: "https",
        path: "/health",
        expectedCodes: "200,204",
      },
      "z1",
    );
    const call = (api.cf.healthchecks.create as Mock).mock.calls[0]![0];
    expect(call.type).toBe("HTTPS");
    expect(call.http_config).toEqual({
      method: "GET",
      path: "/health",
      expected_codes: ["200", "204"],
    });
  });

  it("createHealthcheck throws without a zone", async () => {
    await expect(createHealthcheck(hcApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("editHealthcheck sends only supplied PATCH fields", async () => {
    const api = hcApi();
    await editHealthcheck(api, "acct", "z1/hc1", { suspended: "true", interval: "120" });
    expect(api.cf.healthchecks.edit).toHaveBeenCalledWith(
      "hc1",
      expect.objectContaining({ zone_id: "z1", suspended: true, interval: 120 }),
    );
  });

  it("editHealthcheck throws on a malformed id", async () => {
    await expect(editHealthcheck(hcApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid health check ID",
    );
  });

  it("deleteHealthcheck calls delete", async () => {
    const api = hcApi();
    await deleteHealthcheck(api, "z1/hc1");
    expect(api.cf.healthchecks.delete).toHaveBeenCalledWith("hc1", { zone_id: "z1" });
  });

  it("deleteHealthcheck throws on a malformed id", async () => {
    await expect(deleteHealthcheck(hcApi(), "bad")).rejects.toThrow("Invalid health check ID");
  });
});
