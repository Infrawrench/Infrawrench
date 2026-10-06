import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient, buildInstanceUpdate, splitId } from "../client.js";
import { usageToRows, RATES } from "../cost-data.js";
import { plugin } from "../plugin.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

interface Call {
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
}
let calls: Call[] = [];
let handler: (c: Call) => unknown;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const call = { ...body, headers: init.headers as Record<string, string> };
      calls.push(call);
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const PROJECT = {
  id: "p1",
  name: "shop",
  workspaceId: "w1",
  services: { edges: [{ node: { id: "s1", name: "api" } }] },
  environments: {
    edges: [
      {
        node: {
          id: "e1",
          name: "production",
          serviceInstances: {
            edges: [
              {
                node: {
                  id: "si1",
                  serviceId: "s1",
                  serviceName: "api",
                  environmentId: "e1",
                  region: "us-west2",
                  numReplicas: 2,
                  startCommand: "node server.js",
                  preDeployCommand: ["npm run migrate"],
                  source: { repo: "acme/api", image: null },
                  domains: {
                    serviceDomains: [
                      { id: "sd1", domain: "api-production.up.railway.app", syncStatus: "ACTIVE" },
                    ],
                    customDomains: [
                      {
                        id: "cd1",
                        domain: "api.acme.dev",
                        syncStatus: "ACTIVE",
                        status: {
                          verified: true,
                          certificateStatus: "CERTIFICATE_STATUS_TYPE_VALID",
                          certificates: [{ expiresAt: "2026-12-01T00:00:00Z" }],
                          dnsRecords: [
                            {
                              recordType: "DNS_RECORD_TYPE_CNAME",
                              fqdn: "api.acme.dev",
                              requiredValue: "x.up.railway.app",
                            },
                          ],
                        },
                      },
                    ],
                  },
                  latestDeployment: { id: "d1", status: "SUCCESS", deploymentStopped: false },
                },
              },
            ],
          },
          volumeInstances: {
            edges: [
              {
                node: {
                  id: "vi1",
                  volumeId: "v1",
                  serviceId: null,
                  environmentId: "e1",
                  mountPath: "/data",
                  sizeMB: 5000,
                  currentSizeMB: 1200,
                  state: "READY",
                  volume: { id: "v1", name: "data" },
                },
              },
            ],
          },
        },
      },
    ],
  },
};

function standardRoutes(c: Call): unknown {
  if (c.query.includes("apiToken"))
    return { data: { apiToken: { workspaces: [{ id: "w1", name: "Acme" }] } } };
  if (c.query.includes("query Projects")) {
    return {
      data: {
        projects: {
          pageInfo: { hasNextPage: false },
          edges: [{ node: { id: "p1", name: "shop" } }],
        },
      },
    };
  }
  if (c.query.includes("query ProjectTree")) return { data: { project: PROJECT } };
  throw new Error(`unrouted ${c.query.slice(0, 60)}`);
}

function client(creds: Record<string, string> = { apiToken: "tok" }) {
  return new RailwayClient(creds, RESOURCE_TYPES);
}

describe("transport", () => {
  it("sends a bearer token and maps GraphQL errors to statuses", async () => {
    handler = () => ({ errors: [{ message: "Not Authorized" }], data: null });
    const err = await client()
      .listResources("project", ACCOUNT)
      .catch((e: unknown) => e);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect((err as { status: number }).status).toBe(403);
  });

  it("keeps HTTP statuses from the transport", async () => {
    handler = () => new Response("slow down", { status: 429 });
    const err = await client()
      .listResources("project", ACCOUNT)
      .catch((e: unknown) => e);
    expect((err as { status: number }).status).toBe(429);
  });

  it("follows project pagination", async () => {
    handler = (c) => {
      if (c.query.includes("query Projects")) {
        return c.variables["after"]
          ? {
              data: {
                projects: { pageInfo: { hasNextPage: false }, edges: [{ node: { id: "p2" } }] },
              },
            }
          : {
              data: {
                projects: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  edges: [{ node: { id: "p1" } }],
                },
              },
            };
      }
      if (c.query.includes("query ProjectTree")) {
        return {
          data: { project: { ...PROJECT, id: c.variables["id"], name: String(c.variables["id"]) } },
        };
      }
      return standardRoutes(c);
    };
    const projects = await client().listResources("project", ACCOUNT);
    expect(projects.map((p) => p.externalId)).toEqual(["p1", "p2"]);
  });
});

describe("mappers", () => {
  beforeEach(() => {
    handler = standardRoutes;
  });

  it("maps service instances with environment-scoped ids and outputs", async () => {
    const [svc] = await client().listResources("service", ACCOUNT);
    expect(svc!.id).toBe("acct:service:e1/s1");
    expect(svc!.parentResourceId).toBe("acct:environment:e1");
    expect(svc!.fields).toMatchObject({
      status: "success",
      state: "running",
      region: "us-west2",
      numReplicas: 2,
      preDeployCommand: "npm run migrate",
      url: "https://api.acme.dev",
    });
  });

  it("lists both kinds of domain with certificate expiry", async () => {
    const domains = await client().listResources("domain", ACCOUNT);
    expect(domains.map((d) => d.externalId)).toEqual(["railway/sd1", "custom/cd1"]);
    expect(domains[1]!.fields["certExpiresAt"]).toBe("2026-12-01T00:00:00Z");
    expect(domains[1]!.fields["certificateStatus"]).toBe("valid");
  });

  it("flags unattached volumes", async () => {
    const [v] = await client().listResources("volume", ACCOUNT);
    expect(v!.externalId).toBe("e1/v1");
    expect(v!.fields).toMatchObject({ sizeGb: 5, usedGb: 1.2, serviceId: "", state: "ready" });
  });

  it("lists variable names without storing values", async () => {
    handler = (c) =>
      c.query.includes("query Variables")
        ? { data: { variables: { SECRET: "hunter2" } } }
        : standardRoutes(c);
    const [v] = await client().listResources("variable", ACCOUNT);
    expect(v!.externalId).toBe("e1/s1/SECRET");
    expect(JSON.stringify(v)).not.toContain("hunter2");
    const value = await client().resolveOutput("variable", v!.id, "value", ACCOUNT);
    expect(value).toBe("hunter2");
  });
});

describe("writes", () => {
  beforeEach(() => {
    handler = (c) => (c.query.startsWith("mutation") ? { data: { ok: true } } : standardRoutes(c));
  });

  it("restarts the latest deployment of a service", async () => {
    await client().invokeAction("service", "acct:service:e1/s1", "restart", ACCOUNT);
    const m = calls.find((c) => c.query.includes("deploymentRestart"))!;
    expect(m.variables).toEqual({ id: "d1" });
  });

  it("creates a TCP proxy then redeploys", async () => {
    handler = (c) =>
      c.query.includes("tcpProxyCreate")
        ? {
            data: {
              tcpProxyCreate: { id: "t1", domain: "roundhouse.proxy.rlwy.net", proxyPort: 12345 },
            },
          }
        : c.query.startsWith("mutation")
          ? { data: { serviceInstanceRedeploy: true } }
          : standardRoutes(c);
    const t = await client().createResource("tcp-proxy", ACCOUNT, {
      service: "e1/s1",
      applicationPort: "5432",
    });
    expect(t.fields["endpoint"]).toBe("roundhouse.proxy.rlwy.net:12345");
    expect(calls.some((c) => c.query.includes("serviceInstanceRedeploy"))).toBe(true);
  });

  it("builds instance updates from changed fields only", () => {
    expect(
      buildInstanceUpdate({
        startCommand: "",
        numReplicas: "3",
        sleepApplication: "true",
        preDeployCommand: "x",
      }),
    ).toEqual({
      startCommand: null,
      numReplicas: 3,
      sleepApplication: true,
      preDeployCommand: ["x"],
    });
  });

  it("splits scoped ids and rejects malformed ones", () => {
    expect(splitId("e/s/KEY/with/slash", 3)).toEqual(["e", "s", "KEY/with/slash"]);
    expect(() => splitId("e", 2)).toThrow();
  });
});

describe("costs", () => {
  it("prices minute-integrated usage at the published rates", () => {
    const rows = usageToRows(
      "2026-10-01",
      [
        {
          measurement: "CPU_USAGE",
          value: 43_200,
          tags: { projectId: "p1", environmentId: "e1", serviceId: "s1" },
        },
        { measurement: "NETWORK_TX_GB", value: 10, tags: { projectId: "p1" } },
        { measurement: "MEMORY_USAGE_GB", value: 0, tags: {} },
      ],
      {
        projects: new Map([["p1", "shop"]]),
        environments: new Map(),
        services: new Map([["s1", "api"]]),
      },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      service: "CPU",
      amount: 20,
      resourceId: "e1/s1",
      currency: "USD",
    });
    expect(rows[0]!.tags).toEqual({ project: "shop", environment: "e1", service: "api" });
    expect(rows[1]!.amount).toBeCloseTo(10 * RATES.NETWORK_TX_GB.perUnit);
  });
});

describe("status feed", () => {
  it("maps regional components and ignores billing-only incidents", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        activeIncidents: [
          {
            id: "i1",
            slug: "ABC",
            title: "Deploys stuck",
            status: "INVESTIGATING",
            createdAt: "2026-10-05T00:00:00Z",
            components: [
              {
                name: "Deployments",
                groupName: "US West (California, USA)",
                impact: "PARTIAL_OUTAGE",
              },
            ],
            updates: [
              { status: "INVESTIGATING", message: "Looking", createdAt: "2026-10-05T00:01:00Z" },
            ],
          },
          {
            id: "i2",
            title: "Card payments failing",
            status: "INVESTIGATING",
            components: [{ name: "Payments & Billing", groupName: null }],
          },
        ],
        maintenances: [],
      }),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      regions: ["us-west2"],
      impact: "major",
      url: "https://status.railway.com/incident/ABC",
      lastUpdateText: "Looking",
    });
  });
});

describe("credential options", () => {
  it("lists the token's workspaces", async () => {
    handler = standardRoutes;
    expect(await plugin.listCredentialOptions!("workspaceId", { apiToken: "t" })).toEqual([
      { id: "w1", label: "Acme", description: "w1" },
    ]);
  });
});
