import { describe, expect, it } from "vitest";
import { AliApi } from "../api.js";
import { makeClient } from "./helpers.js";

const GATEWAY = "<html>gateway</html>";

describe("a 2xx answer that is not JSON", () => {
  it("fails a list instead of reading as no rows", async () => {
    const alb = makeClient((req) =>
      req.action === "ListLoadBalancers" ? { raw: GATEWAY } : undefined,
    );
    await expect(alb.client.listResources("alb", "acct")).rejects.toThrow("InvalidResponse");

    const fc = makeClient((req) => (req.action === "ListFunctions" ? { raw: GATEWAY } : undefined));
    await expect(fc.client.listResources("fc-function", "acct")).rejects.toThrow("InvalidResponse");
  });

  it("is still handed back to a ROA write", async () => {
    const api = new AliApi(
      { accessKeyId: "LTAI5ttest", accessKeySecret: "secret" },
      {
        request: async () => ({ status: 200, headers: {}, body: "accepted" }),
      } as never,
      "",
    );
    const answer = await api.roa<string>({
      product: "fc",
      region: "ap-southeast-1",
      action: "UpdateFunction",
      method: "PUT",
      path: "/2023-03-30/functions/f",
      body: {},
    });
    expect(answer).toBe("accepted");
  });
});
