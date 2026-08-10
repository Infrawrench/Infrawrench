import { describe, it, expect } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { digitaloceanTerraformExport, relativeDnsRecordName } from "../terraform.js";

function dnsRecord(fields: Record<string, string | number | boolean>): ResourceInstance {
  return {
    id: "acc:dns-record:example.com/1",
    pluginId: "digitalocean",
    resourceTypeId: "dns-record",
    accountId: "acc",
    displayName: "A record",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "example.com/1",
    createdAt: "",
    updatedAt: "",
  };
}

describe("relativeDnsRecordName", () => {
  it("maps an apex FQDN to @", () => {
    expect(relativeDnsRecordName("example.com", "example.com")).toBe("@");
  });

  it("strips the zone suffix from a subdomain FQDN", () => {
    expect(relativeDnsRecordName("www.example.com", "example.com")).toBe("www");
    expect(relativeDnsRecordName("a.b.example.com", "example.com")).toBe("a.b");
  });

  it("leaves already-relative names alone", () => {
    expect(relativeDnsRecordName("www", "example.com")).toBe("www");
    expect(relativeDnsRecordName("@", "example.com")).toBe("@");
  });
});

describe("digitaloceanTerraformExport dns-record", () => {
  it("emits a relative name for FQDN-stored subdomain records", () => {
    const result = digitaloceanTerraformExport.mapResource(
      dnsRecord({
        type: "A",
        name: "www.example.com",
        data: "1.2.3.4",
        domainName: "example.com",
      }),
    );
    expect(result?.resource.attributes).toMatchObject({
      domain: { kind: "string", value: "example.com" },
      type: { kind: "string", value: "A" },
      name: { kind: "string", value: "www" },
      value: { kind: "string", value: "1.2.3.4" },
    });
  });

  it("emits @ for apex records stored as the bare domain", () => {
    const result = digitaloceanTerraformExport.mapResource(
      dnsRecord({
        type: "A",
        name: "example.com",
        data: "1.2.3.4",
        domainName: "example.com",
      }),
    );
    expect(result?.resource.attributes["name"]).toEqual({ kind: "string", value: "@" });
  });
});
