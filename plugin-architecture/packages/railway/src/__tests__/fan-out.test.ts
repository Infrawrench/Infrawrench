import { describe, expect, it } from "vitest";
import {
  ACC,
  NOT_A_LIST,
  client,
  conn,
  env,
  isolate,
  project,
  routes,
  trackUnread,
} from "./helpers.js";

isolate();

describe("per-service fan-out", () => {
  const many = Array.from({ length: 60 }, (_, i) => `s${String(i).padStart(2, "0")}`);

  it("reads a budget of services each poll and names the rest", async () => {
    const parts = trackUnread();
    const { c, calls } = client(
      routes(
        () => project({ environments: conn([env("e1", many)]) }),
        (call) =>
          call.query.includes("query TcpProxies(") ? { data: { tcpProxies: [] } } : undefined,
      ),
    );
    await c.listResources("tcp-proxy", ACC);
    const read = calls
      .filter((x) => x.query.includes("query TcpProxies("))
      .map((x) => `${ACC}:service:e1/${String(x.variables["serviceId"])}`);
    const unread = parts.flatMap((p) => p.parentResourceIds ?? []);
    expect(read.length).toBe(50);
    expect(unread.length).toBe(10);
    expect(new Set([...read, ...unread]).size).toBe(60);
  });

  it("reads every service on a host that keeps no track", async () => {
    const { c, calls } = client(
      routes(
        () => project({ environments: conn([env("e1", many)]) }),
        (call) =>
          call.query.includes("query TcpProxies(") ? { data: { tcpProxies: [] } } : undefined,
      ),
    );
    await c.listResources("tcp-proxy", ACC);
    expect(calls.filter((x) => x.query.includes("query TcpProxies(")).length).toBe(60);
  });

  it("names a service the token is refused for, so its rows stay", async () => {
    const parts = trackUnread();
    const { c } = client(
      routes(
        () => project({ environments: conn([env("e1", ["s1", "s2"])]) }),
        (call) => {
          if (!call.query.includes("query TcpProxies(")) return undefined;
          if (call.variables["serviceId"] === "s1")
            return { data: null, errors: [{ message: "Not Authorized" }] };
          return {
            data: {
              tcpProxies: [
                {
                  id: "t2",
                  domain: "x.proxy.rlwy.net",
                  proxyPort: 1,
                  applicationPort: 2,
                  serviceId: "s2",
                  environmentId: "e1",
                },
              ],
            },
          };
        },
      ),
    );
    const rows = await c.listResources("tcp-proxy", ACC);
    expect(rows.map((r) => r.externalId)).toEqual(["t2"]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACC}:service:e1/s1`] }]);
  });

  it("still finds one resource past the budget when asked for it", async () => {
    trackUnread();
    const { c } = client(
      routes(
        () => project({ environments: conn([env("e1", many)]) }),
        (call) =>
          call.query.includes("query TcpProxies(")
            ? {
                data: {
                  tcpProxies: [
                    {
                      id: `t-${String(call.variables["serviceId"])}`,
                      domain: "x.proxy.rlwy.net",
                      proxyPort: 1,
                      applicationPort: 2,
                      serviceId: call.variables["serviceId"],
                      environmentId: "e1",
                    },
                  ],
                },
              }
            : undefined,
      ),
    );
    for (const s of many) {
      const r = await c.getResource("tcp-proxy", `${ACC}:tcp-proxy:t-${s}`, ACC);
      expect(r.externalId).toBe(`t-${s}`);
    }
  });

  it("names an environment the token is refused shared variables for", async () => {
    const parts = trackUnread();
    const { c } = client(
      routes(
        () => project({ environments: conn([env("e1", []), env("e2", [])]) }),
        (call) => {
          if (!call.query.includes("query Variables(")) return undefined;
          if (call.variables["environmentId"] === "e1")
            return { data: null, errors: [{ message: "Not Authorized" }] };
          return { data: { variables: { TOKEN: "x" } } };
        },
      ),
    );
    const rows = await c.listResources("shared-variable", ACC);
    expect(rows.map((r) => r.externalId)).toEqual(["e2/TOKEN"]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACC}:environment:e1`] }]);
  });

  it("shows one environment's refusal on a host that keeps no track", async () => {
    const { c } = client(
      routes(
        () => project({ environments: conn([env("e1", []), env("e2", [])]) }),
        (call) => {
          if (!call.query.includes("query Variables(")) return undefined;
          if (call.variables["environmentId"] === "e1")
            return { data: null, errors: [{ message: "Not Authorized" }] };
          return { data: { variables: { TOKEN: "x" } } };
        },
      ),
    );
    await expect(c.listResources("shared-variable", ACC)).rejects.toMatchObject({ status: 403 });
  });

  it("shows a refusal on a host that keeps no track when every service is refused", async () => {
    const { c } = client(
      routes(
        () => project({}),
        (call) =>
          call.query.includes("query TcpProxies(")
            ? { data: null, errors: [{ message: "Not Authorized" }] }
            : undefined,
      ),
    );
    await expect(c.listResources("tcp-proxy", ACC)).rejects.toMatchObject({ status: 403 });
  });
});
