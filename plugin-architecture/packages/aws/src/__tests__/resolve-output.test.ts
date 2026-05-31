import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const jsonCall = vi.fn();
const jsonGetCall = vi.fn();
vi.mock("../client-transport.js", () => ({
  jsonCall: (...a: unknown[]) => jsonCall(...a),
  jsonGetCall: (...a: unknown[]) => jsonGetCall(...a),
}));

import { resolveOutput } from "../resolve-output.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function res(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "id",
    pluginId: "aws",
    resourceTypeId: "t",
    accountId: "acct",
    displayName: "d",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "ext",
    createdAt: "",
    updatedAt: "",
    ...over,
  } as ResourceInstance;
}

function makeCtx(resource: ResourceInstance, exportContent = "[default]") {
  return {
    creds,
    credsFor: (region: string) => ({ ...creds, region }),
    getResource: vi.fn(async () => resource),
    exportCredential: vi.fn(async () => ({ content: exportContent }) as { content: string }),
  };
}

beforeEach(() => {
  jsonCall.mockReset();
  jsonGetCall.mockReset();
});

describe("resolveOutput acm-certificate", () => {
  it("returns dnsRecords from DomainValidationOptions", async () => {
    const r = res({ externalId: "arn:cert", fields: { region: "us-west-2" } });
    jsonCall.mockResolvedValue({
      Certificate: {
        DomainValidationOptions: [
          { ResourceRecord: { Name: "_x.example.com", Type: "CNAME", Value: "val.acm." } },
          { ResourceRecord: undefined },
        ],
      },
    });
    const out = await resolveOutput(makeCtx(r), "acm-certificate", "rid", "dnsRecords", "acct");
    expect(out).toBe("CNAME _x.example.com -> val.acm.");
  });
  it("returns domainValidationStatus", async () => {
    const r = res({ externalId: "arn:cert" });
    jsonCall.mockResolvedValue({
      Certificate: {
        DomainValidationOptions: [
          { DomainName: "example.com", ValidationStatus: "SUCCESS", ValidationMethod: "DNS" },
        ],
      },
    });
    const out = await resolveOutput(
      makeCtx(r),
      "acm-certificate",
      "rid",
      "domainValidationStatus",
      "acct",
    );
    expect(out).toBe("example.com (DNS): SUCCESS");
  });
  it("returns '' when no externalId", async () => {
    const r = res({ externalId: "" });
    expect(await resolveOutput(makeCtx(r), "acm-certificate", "rid", "dnsRecords", "acct")).toBe(
      "",
    );
  });
  it("returns '' when cert missing", async () => {
    const r = res({ externalId: "arn" });
    jsonCall.mockResolvedValue({});
    expect(await resolveOutput(makeCtx(r), "acm-certificate", "rid", "dnsRecords", "acct")).toBe(
      "",
    );
  });
  it("returns '' when no DomainValidationOptions", async () => {
    const r = res({ externalId: "arn" });
    jsonCall.mockResolvedValue({ Certificate: {} });
    expect(
      await resolveOutput(makeCtx(r), "acm-certificate", "rid", "domainValidationStatus", "acct"),
    ).toBe("");
  });
  it("returns '' on API error", async () => {
    const r = res({ externalId: "arn" });
    jsonCall.mockRejectedValue(new Error("denied"));
    expect(await resolveOutput(makeCtx(r), "acm-certificate", "rid", "dnsRecords", "acct")).toBe(
      "",
    );
  });
});

describe("resolveOutput iam-user accessKey", () => {
  it("delegates to exportCredential", async () => {
    const r = res();
    const ctx = makeCtx(r, "ini-content");
    expect(await resolveOutput(ctx, "iam-user", "rid", "accessKey", "acct")).toBe("ini-content");
    expect(ctx.exportCredential).toHaveBeenCalledWith("iam-user", "rid", "acct", "access-key");
  });
});

describe("resolveOutput msk-cluster bootstrapBrokers", () => {
  it("prefers SCRAM string", async () => {
    const r = res({ resolvedOutputs: { clusterArn: "arn:msk" }, fields: { region: "us-east-1" } });
    jsonGetCall.mockResolvedValue({
      BootstrapBrokerStringSaslScram: "scram:9096",
      BootstrapBrokerStringTls: "tls:9094",
    });
    expect(await resolveOutput(makeCtx(r), "msk-cluster", "rid", "bootstrapBrokers", "acct")).toBe(
      "scram:9096",
    );
  });
  it("falls back to TLS then IAM", async () => {
    const r = res({ resolvedOutputs: { clusterArn: "arn:msk" } });
    jsonGetCall.mockResolvedValue({ BootstrapBrokerStringSaslIam: "iam:9098" });
    expect(await resolveOutput(makeCtx(r), "msk-cluster", "rid", "bootstrapBrokers", "acct")).toBe(
      "iam:9098",
    );
  });
  it("returns '' when no arn", async () => {
    const r = res({ resolvedOutputs: {} });
    expect(await resolveOutput(makeCtx(r), "msk-cluster", "rid", "bootstrapBrokers", "acct")).toBe(
      "",
    );
  });
  it("returns '' on error", async () => {
    const r = res({ resolvedOutputs: { clusterArn: "arn" } });
    jsonGetCall.mockRejectedValue(new Error("x"));
    expect(await resolveOutput(makeCtx(r), "msk-cluster", "rid", "bootstrapBrokers", "acct")).toBe(
      "",
    );
  });
});

describe("resolveOutput generic", () => {
  it("returns a resolvedOutput value", async () => {
    const r = res({ resolvedOutputs: { functionArn: "arn:fn" } });
    expect(await resolveOutput(makeCtx(r), "lambda-function", "rid", "functionArn", "acct")).toBe(
      "arn:fn",
    );
  });
  it("throws when output key missing", async () => {
    const r = res({ resolvedOutputs: {} });
    await expect(
      resolveOutput(makeCtx(r), "lambda-function", "rid", "nope", "acct"),
    ).rejects.toThrow(/cannot resolve output/);
  });
});
