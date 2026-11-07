import { describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";

import { jsonCall } from "../client-transport.js";

describe("the Service Quotas transport", () => {
  it("signs and sends to the service's own endpoint, which has no SDK client in the bundle", async () => {
    const request = vi.fn<HttpHostServices["request"]>(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ Quotas: [] }),
    }));
    const out = await jsonCall(
      {
        accessKeyId: "AKIAFAKE",
        secretAccessKey: "secret",
        region: "eu-west-1",
        http: { request },
      },
      "servicequotas",
      "ServiceQuotasV20190624.ListServiceQuotas",
      { ServiceCode: "ec2" },
    );
    expect(out).toEqual({ Quotas: [] });
    const sent = request.mock.calls[0]![0];
    expect(sent.url).toBe("https://servicequotas.eu-west-1.amazonaws.com/");
    expect(sent.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(sent.headers["authorization"]).toContain("/eu-west-1/servicequotas/aws4_request");
  });
});
