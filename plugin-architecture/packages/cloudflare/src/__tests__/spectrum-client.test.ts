import { describe, it, expect, vi } from "vitest";
import {
  listAllSpectrumApplications,
  createSpectrumApplication,
  editSpectrumApplication,
  deleteSpectrumApplication,
} from "../clients/spectrum-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const APP = {
  id: "s1",
  protocol: "tcp/22",
  dns: { name: "ssh.a.com" },
  origin_direct: ["tcp://1.2.3.4:22"],
  ip_firewall: true,
  proxy_protocol: "off",
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

function spApi(over: Record<string, unknown> = {}) {
  const apps = {
    list: vi.fn(() => asyncIter([APP])),
    create: vi.fn(async () => APP),
    update: vi.fn(async () => APP),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { spectrum: { apps } }, ...over });
}

describe("spectrum-client", () => {
  it("listAllSpectrumApplications maps an app", async () => {
    const api = spApi();
    const out = await listAllSpectrumApplications(api, "acct");
    expect(out[0].id).toBe("acct:spectrum-application:z1/s1");
    expect(out[0].fields.protocol).toBe("tcp/22");
    expect(out[0].fields.dns).toBe("ssh.a.com");
    expect(out[0].fields.originDirect).toBe("tcp://1.2.3.4:22");
  });

  it("createSpectrumApplication builds a CNAME dns + origin", async () => {
    const api = spApi();
    await createSpectrumApplication(
      api,
      "acct",
      {
        protocol: "tcp/22",
        dns: "ssh.a.com",
        originDirect: "tcp://1.2.3.4:22",
        ipFirewall: "true",
      },
      "z1",
    );
    expect(api.cf.spectrum.apps.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: "z1",
        protocol: "tcp/22",
        dns: { type: "CNAME", name: "ssh.a.com" },
        origin_direct: ["tcp://1.2.3.4:22"],
        ip_firewall: true,
      }),
    );
  });

  it("createSpectrumApplication throws without a zone", async () => {
    await expect(createSpectrumApplication(spApi(), "acct", {}, "")).rejects.toThrow(
      /zoneId is required/,
    );
  });

  it("editSpectrumApplication rebuilds the body", async () => {
    const api = spApi();
    await editSpectrumApplication(api, "acct", "z1/s1", {
      protocol: "tcp/22",
      dns: "ssh.a.com",
      originDirect: "tcp://1.2.3.4:22, tcp://5.6.7.8:22",
      proxyProtocol: "v1",
    });
    const call = (api.cf.spectrum.apps.update as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(call.origin_direct).toEqual(["tcp://1.2.3.4:22", "tcp://5.6.7.8:22"]);
    expect(call.proxy_protocol).toBe("v1");
  });

  it("editSpectrumApplication throws on a malformed id", async () => {
    await expect(editSpectrumApplication(spApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid spectrum application ID",
    );
  });

  it("deleteSpectrumApplication calls delete", async () => {
    const api = spApi();
    await deleteSpectrumApplication(api, "z1/s1");
    expect(api.cf.spectrum.apps.delete).toHaveBeenCalledWith("s1", { zone_id: "z1" });
  });

  it("deleteSpectrumApplication throws on a malformed id", async () => {
    await expect(deleteSpectrumApplication(spApi(), "bad")).rejects.toThrow(
      "Invalid spectrum application ID",
    );
  });
});
