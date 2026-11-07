import { describe, expect, it } from "vitest";
import { ACC, NOT_A_LIST, client, isolate, project, routes } from "./helpers.js";

isolate();

describe("lists that are not a list", () => {
  it("refuses an answer with no workspace list instead of reading it as none", async () => {
    const { c } = client(
      routes(
        () => project({}),
        (call) => (call.query.includes("apiToken") ? { data: { apiToken: {} } } : undefined),
      ),
    );
    await expect(c.listResources("project", ACC)).rejects.toThrow(NOT_A_LIST);
  });
  it("refuses a TCP proxy answer with no list instead of reading it as none", async () => {
    const { c } = client(
      routes(
        () => project({}),
        (call) => (call.query.includes("query TcpProxies(") ? { data: { other: [] } } : undefined),
      ),
    );
    await expect(c.listResources("tcp-proxy", ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a variables answer that is not a map instead of reading it as none", async () => {
    const { c } = client(
      routes(
        () => project({}),
        (call) => (call.query.includes("query Variables(") ? { data: { vars: {} } } : undefined),
      ),
    );
    await expect(c.listResources("variable", ACC)).rejects.toThrow(NOT_A_LIST);
    await expect(c.listResources("shared-variable", ACC)).rejects.toThrow(NOT_A_LIST);
  });
});
