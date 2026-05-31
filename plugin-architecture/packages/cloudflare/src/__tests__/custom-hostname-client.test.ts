import { describe, it, expect, vi } from "vitest";
import {
  listAllCustomHostnames,
  createCustomHostname,
  editCustomHostname,
  deleteCustomHostname,
} from "../clients/custom-hostname-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const HOSTNAME = {
  id: "h1",
  hostname: "shop.example.com",
  status: "active",
  ssl: { status: "active", method: "http", type: "dv" },
  created_at: "2020-01-01T00:00:00Z",
};

function chApi(over: Record<string, unknown> = {}) {
  const customHostnames = {
    list: vi.fn(() => asyncIter([HOSTNAME])),
    create: vi.fn(async () => HOSTNAME),
    edit: vi.fn(async () => HOSTNAME),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { customHostnames }, ...over });
}

describe("custom-hostname-client", () => {
  it("listAllCustomHostnames maps across zones", async () => {
    const api = chApi();
    const out = await listAllCustomHostnames(api, "acct");
    expect(out[0]!.id).toBe("acct:custom-hostname:z1/h1");
    expect(out[0]!.parentResourceId).toBe("acct:zone:z1");
    expect(out[0]!.fields.sslStatus).toBe("active");
    expect(api.cf.customHostnames.list).toHaveBeenCalledWith({ zone_id: "z1" });
  });

  it("createCustomHostname builds a DV ssl body", async () => {
    const api = chApi();
    await createCustomHostname(api, "acct", { hostname: "shop.example.com" }, "z1");
    expect(api.cf.customHostnames.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: "z1",
        hostname: "shop.example.com",
        ssl: { method: "http", type: "dv" },
      }),
    );
  });

  it("createCustomHostname throws without a zone", async () => {
    await expect(createCustomHostname(chApi(), "acct", {}, "")).rejects.toThrow(
      /zoneId is required/,
    );
  });

  it("editCustomHostname updates ssl method", async () => {
    const api = chApi();
    await editCustomHostname(api, "acct", "z1/h1", { sslMethod: "txt" });
    expect(api.cf.customHostnames.edit).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ zone_id: "z1", ssl: { method: "txt", type: "dv" } }),
    );
  });

  it("editCustomHostname throws on a malformed id", async () => {
    await expect(editCustomHostname(chApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid custom hostname ID",
    );
  });

  it("deleteCustomHostname parses the composite id", async () => {
    const api = chApi();
    await deleteCustomHostname(api, "z1/h1");
    expect(api.cf.customHostnames.delete).toHaveBeenCalledWith("h1", { zone_id: "z1" });
  });

  it("deleteCustomHostname throws on a malformed id", async () => {
    await expect(deleteCustomHostname(chApi(), "bad")).rejects.toThrow(
      "Invalid custom hostname ID",
    );
  });
});
