import { describe, it, expect, vi } from "vitest";
import {
  listAllLoadBalancers,
  createLoadBalancer,
  editLoadBalancer,
  deleteLoadBalancer,
} from "../clients/load-balancer-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const LB = {
  id: "lb1",
  name: "web",
  fallback_pool: "pool-f",
  default_pools: ["pool-a", "pool-b"],
  enabled: true,
  proxied: true,
  ttl: 30,
  steering_policy: "dynamic_latency",
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

function lbApi(over: Record<string, unknown> = {}) {
  const loadBalancers = {
    list: vi.fn(() => asyncIter([LB])),
    create: vi.fn(async () => LB),
    edit: vi.fn(async () => LB),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { loadBalancers }, ...over });
}

describe("load-balancer-client", () => {
  it("listAllLoadBalancers maps an LB", async () => {
    const api = lbApi();
    const out = await listAllLoadBalancers(api, "acct");
    expect(out[0]!.id).toBe("acct:load-balancer:z1/lb1");
    expect(out[0]!.fields.defaultPools).toBe("pool-a, pool-b");
    expect(out[0]!.fields.steeringPolicy).toBe("dynamic_latency");
  });

  it("createLoadBalancer parses default pools CSV", async () => {
    const api = lbApi();
    await createLoadBalancer(
      api,
      "acct",
      { name: "web", fallbackPool: "pool-f", defaultPools: "pool-a, pool-b" },
      "z1",
    );
    expect(api.cf.loadBalancers.create).toHaveBeenCalledWith(
      expect.objectContaining({ default_pools: ["pool-a", "pool-b"], fallback_pool: "pool-f" }),
    );
  });

  it("createLoadBalancer throws without a zone", async () => {
    await expect(createLoadBalancer(lbApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("editLoadBalancer sends only supplied fields", async () => {
    const api = lbApi();
    await editLoadBalancer(api, "acct", "z1/lb1", { enabled: "false", ttl: "60", proxied: "true" });
    expect(api.cf.loadBalancers.edit).toHaveBeenCalledWith(
      "lb1",
      expect.objectContaining({ zone_id: "z1", enabled: false, ttl: 60, proxied: true }),
    );
  });

  it("editLoadBalancer throws on a malformed id", async () => {
    await expect(editLoadBalancer(lbApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid load balancer ID",
    );
  });

  it("deleteLoadBalancer calls delete", async () => {
    const api = lbApi();
    await deleteLoadBalancer(api, "z1/lb1");
    expect(api.cf.loadBalancers.delete).toHaveBeenCalledWith("lb1", { zone_id: "z1" });
  });

  it("deleteLoadBalancer throws on a malformed id", async () => {
    await expect(deleteLoadBalancer(lbApi(), "bad")).rejects.toThrow("Invalid load balancer ID");
  });
});
