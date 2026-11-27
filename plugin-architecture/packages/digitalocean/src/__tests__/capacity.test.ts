import { hostClient } from "@infrawrench/plugin-base/effect";
import {
  capacityDeclarations,
  resolveCapacityLimit,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanClient } from "../client.js";
import { FILESYSTEM_USED_LABEL, fetchDoMetricSeries } from "../metric-series.js";
import { plugin } from "../plugin.js";
import { autoscaleNodes } from "../resource-listers.js";
import { LB_CONNECTIONS_USED_LABEL, LB_TLS_RATE_USED_LABEL } from "../service-ops.js";
import { mapAutoscalePool } from "../service-listers.js";
import { fakeApi } from "./fake-api.js";

const ACC = "acc1";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function installFetch(route: (path: string) => unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const result = route(url.replace("https://api.digitalocean.com/v2", ""));
    return result === undefined ? jsonResponse({ id: "not_found" }, 404) : jsonResponse(result);
  }) as typeof fetch);
}

const client = () => hostClient(new DigitalOceanClient({ apiToken: "tok" }));

function type(id: string) {
  const t = plugin.resourceTypes.find((r) => r.id === id);
  if (!t) throw new Error(id);
  return t;
}

afterEach(() => vi.restoreAllMocks());

describe("container registry repositories", () => {
  it("counts repositories from meta.total against the tier's included repositories", async () => {
    installFetch((path) => {
      if (path === "/registry") return { registry: { name: "acme", storage_usage_bytes: 10 } };
      if (path === "/registry/subscription") {
        return {
          subscription: {
            tier: {
              slug: "starter",
              included_repositories: 1,
              included_storage_bytes: 524288000,
              included_bandwidth_bytes: 524288000,
            },
          },
        };
      }
      if (path === "/registry/acme/repositoriesV2?per_page=1") {
        return { repositories: [{ name: "repo-1", tag_count: 3 }], meta: { total: 1 } };
      }
      return undefined;
    });
    const [registry] = await client().listResources("container-registry", ACC);
    expect(registry!.fields).toMatchObject({ repositoryCount: 1, includedRepositories: 1 });
    const decl = capacityDeclarations(type("container-registry")).find(
      (d) => d.key === "repositoryCount",
    );
    expect(resolveCapacityLimit(decl!.declaration.limit, registry!.fields)?.limit).toBe(1);
  });

  it("leaves the limit out for an unlimited tier and the count out when the read fails", async () => {
    installFetch((path) => {
      if (path === "/registry") return { registry: { name: "acme" } };
      if (path === "/registry/subscription") {
        return { subscription: { tier: { slug: "professional", included_repositories: 0 } } };
      }
      return undefined;
    });
    const [registry] = await client().listResources("container-registry", ACC);
    expect(registry!.fields).not.toHaveProperty("repositoryCount");
    expect(registry!.fields).not.toHaveProperty("includedRepositories");
  });
});

describe("DOKS autoscaling nodes", () => {
  it("sums the autoscaling pools' nodes against their max_nodes", () => {
    expect(
      autoscaleNodes([
        { auto_scale: true, count: 3, min_nodes: 1, max_nodes: 5 } as never,
        { auto_scale: true, count: 2, max_nodes: 4 },
        { auto_scale: false, count: 10 },
      ]),
    ).toEqual({ autoscaleNodeCount: 5, autoscaleMaxNodes: 9 });
  });

  it("states nothing for a cluster with only fixed-size pools", () => {
    expect(autoscaleNodes([{ auto_scale: false, count: 3, max_nodes: 0 }])).toEqual({});
    expect(autoscaleNodes(undefined)).toEqual({});
  });

  it("declares the count against the maximum", () => {
    const decl = capacityDeclarations(type("doks-cluster")).find(
      (d) => d.key === "autoscaleNodeCount",
    );
    expect(resolveCapacityLimit(decl!.declaration.limit, { autoscaleMaxNodes: 9 })?.limit).toBe(9);
  });
});

describe("autoscale pool size", () => {
  it("stores the active Droplets against a dynamic pool's max_instances", () => {
    const pool = mapAutoscalePool(
      {
        id: "p1",
        name: "web",
        active_resources_count: 4,
        config: { min_instances: 1, max_instances: 5, target_cpu_utilization: 0.5 },
        droplet_template: { size: "s-1vcpu-1gb", region: "nyc3", image: "ubuntu" } as never,
      },
      ACC,
    );
    expect(pool.fields).toMatchObject({ activeResourcesCount: 4, maxInstances: 5 });
    const decl = capacityDeclarations(type("autoscale-pool")).find(
      (d) => d.key === "activeResourcesCount",
    );
    expect(resolveCapacityLimit(decl!.declaration.limit, pool.fields)?.limit).toBe(5);
  });

  it("has no ceiling for a static pool and no count when DO leaves it out", () => {
    const pool = mapAutoscalePool({ id: "p1", config: { target_number_instances: 3 } }, ACC);
    expect(resolveCapacityLimit({ field: "maxInstances" }, pool.fields)).toBeNull();
    expect(pool.fields["activeResourcesCount"]).toBe("");
  });
});

describe("Droplet root filesystem used", () => {
  const droplet = { externalId: "222651441" } as ResourceInstance;
  const fs = (mountpoint: string, values: Array<[number, string]>) => ({
    metric: { device: "/dev/vda1", fstype: "ext4", host_id: "222651441", mountpoint },
    values,
  });

  it("derives the root filesystem's used percent from its size and free bytes", async () => {
    const api = fakeApi(async (path) => {
      if (path.startsWith("/monitoring/metrics/droplet/filesystem_size")) {
        return {
          data: {
            result: [
              fs("/boot", [[1_700_000_000, "1000"]]),
              fs("/", [
                [1_700_000_000, "100000"],
                [1_700_000_120, "100000"],
              ]),
            ],
          },
        };
      }
      if (path.startsWith("/monitoring/metrics/droplet/filesystem_free")) {
        return {
          data: {
            result: [
              fs("/", [
                [1_700_000_000, "75000"],
                [1_700_000_120, "60000"],
              ]),
              fs("/boot", [[1_700_000_000, "10"]]),
            ],
          },
        };
      }
      throw new Error(`unrouted ${path}`);
    });
    const series = await fetchDoMetricSeries(
      { api, getResource: async () => droplet },
      "droplet",
      `${ACC}:droplet:222651441`,
      ACC,
      { startMs: 1_700_000_000_000, endMs: 1_700_003_600_000 },
    );
    const used = series.find((s) => s.label === FILESYSTEM_USED_LABEL);
    expect(used?.unit).toBe("%");
    expect(used?.points.map((p) => p.value)).toEqual([25, 40]);
    expect(series.find((s) => s.label === "Filesystem Size")?.points[0]?.value).toBe(100000);
    expect(type("droplet").capacityMetrics?.map((m) => m.seriesLabel)).toEqual([
      FILESYSTEM_USED_LABEL,
    ]);
  });

  it("emits no used series without the Metrics Agent", async () => {
    const api = fakeApi(async () => {
      throw new Error("DigitalOcean API error 404");
    });
    const series = await fetchDoMetricSeries(
      { api, getResource: async () => droplet },
      "droplet",
      `${ACC}:droplet:222651441`,
      ACC,
    );
    expect(series).toEqual([]);
  });
});

describe("load balancer connections used", () => {
  it("derives connections and the TLS rate as a share of their limits", async () => {
    const at = (value: string) => ({ data: { result: [{ metric: {}, values: [[1, value]] }] } });
    installFetch((path) => {
      const name = /load_balancer\/([a-z_]+)/.exec(path)?.[1];
      if (name === "frontend_connections_current") return at("2500");
      if (name === "frontend_connections_limit") return at("10000");
      if (name === "frontend_tls_connections_current") return at("50");
      if (name === "frontend_tls_connections_limit") return at("250");
      return undefined;
    });
    const series = await client().fetchMetricSeries(
      "load-balancer",
      `${ACC}:load-balancer:lb-1`,
      ACC,
      { startMs: 0, endMs: 1000 },
    );
    expect(series.find((s) => s.label === LB_CONNECTIONS_USED_LABEL)?.points).toEqual([
      { timestamp: 1000, value: 25 },
    ]);
    expect(series.find((s) => s.label === LB_TLS_RATE_USED_LABEL)?.points).toEqual([
      { timestamp: 1000, value: 20 },
    ]);
    expect(type("load-balancer").capacityMetrics?.map((m) => m.seriesLabel)).toEqual([
      LB_CONNECTIONS_USED_LABEL,
      LB_TLS_RATE_USED_LABEL,
    ]);
  });
});
