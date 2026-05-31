import { describe, it, expect, vi } from "vitest";
import {
  listAllSSLCertificates,
  createSSLCertificate,
  deleteSSLCertificate,
} from "../clients/ssl-certificate-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const CERT = {
  id: "c1",
  hosts: ["a.com", "www.a.com"],
  status: "active",
  type: "sni_custom",
  certificate_authority: "DigiCert",
  certificates: [{ issuer: "DigiCert Inc", expires_on: "2025-01-01" }],
};

function sslApi(over: Record<string, unknown> = {}) {
  const customCertificates = {
    list: vi.fn(() => asyncIter([CERT])),
    create: vi.fn(async () => CERT),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { customCertificates }, ...over });
}

describe("ssl-certificate-client", () => {
  it("listAllSSLCertificates maps a cert with zone name", async () => {
    const api = sslApi();
    const out = await listAllSSLCertificates(api, "acct");
    expect(out[0]!.id).toBe("acct:ssl-certificate:z1/c1");
    expect(out[0]!.fields.hosts).toBe("a.com, www.a.com");
    expect(out[0]!.fields.issuer).toBe("DigiCert Inc");
    expect(out[0]!.fields.expiresOn).toBe("2025-01-01");
    expect(out[0]!.fields.zoneName).toBe("a.com");
  });

  it("createSSLCertificate posts cert + key and resolves zone name", async () => {
    const api = sslApi();
    const out = await createSSLCertificate(
      api,
      "acct",
      { certificate: "PEM", privateKey: "KEY" },
      "z1",
    );
    expect(api.cf.customCertificates.create).toHaveBeenCalledWith(
      expect.objectContaining({ zone_id: "z1", certificate: "PEM", private_key: "KEY" }),
    );
    expect(out.fields.zoneName).toBe("a.com");
  });

  it("createSSLCertificate throws without a zone", async () => {
    await expect(createSSLCertificate(sslApi(), "acct", {}, "")).rejects.toThrow(
      /zoneId is required/,
    );
  });

  it("deleteSSLCertificate calls delete", async () => {
    const api = sslApi();
    await deleteSSLCertificate(api, "z1/c1");
    expect(api.cf.customCertificates.delete).toHaveBeenCalledWith("c1", { zone_id: "z1" });
  });

  it("deleteSSLCertificate throws on a malformed id", async () => {
    await expect(deleteSSLCertificate(sslApi(), "bad")).rejects.toThrow(
      "Invalid SSL certificate ID",
    );
  });
});
