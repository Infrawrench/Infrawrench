import { describe, expect, it } from "vitest";
import type { CiLentValue } from "@infrawrench/plugin-base";

import { AZURE_CI_CREDENTIAL, lendServicePrincipal } from "../ci-credential.js";

const text = (value: CiLentValue) =>
  typeof value === "string" ? value : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
const secrets = (value: CiLentValue) =>
  typeof value === "string" ? [value] : value.flatMap((p) => ("secret" in p ? [p.secret] : []));

const creds = {
  tenantId: "00000000-0000-0000-0000-00000000000a",
  clientId: "00000000-0000-0000-0000-00000000000b",
  clientSecret: "fixture-client-secret",
  subscriptionId: "00000000-0000-0000-0000-00000000000c",
};

describe("lendServicePrincipal", () => {
  it("sets what the Azure SDKs and Terraform read, only the secret masked", () => {
    const material = lendServicePrincipal(creds);
    const env = Object.fromEntries(Object.entries(material.env).map(([k, v]) => [k, text(v)]));
    expect(env).toEqual({
      AZURE_CLIENT_ID: creds.clientId,
      AZURE_TENANT_ID: creds.tenantId,
      AZURE_CLIENT_SECRET: creds.clientSecret,
      AZURE_SUBSCRIPTION_ID: creds.subscriptionId,
      ARM_CLIENT_ID: creds.clientId,
      ARM_TENANT_ID: creds.tenantId,
      ARM_CLIENT_SECRET: creds.clientSecret,
      ARM_SUBSCRIPTION_ID: creds.subscriptionId,
    });
    const masked = Object.values(material.env).flatMap(secrets);
    expect(masked).toEqual([creds.clientSecret, creds.clientSecret]);
    expect(material.files).toEqual([]);
    expect(material.expiresAt).toBeUndefined();
  });

  it("is declared as the stored secret, not a short-lived one", () => {
    expect(AZURE_CI_CREDENTIAL.shortLived).toBe(false);
  });
});
