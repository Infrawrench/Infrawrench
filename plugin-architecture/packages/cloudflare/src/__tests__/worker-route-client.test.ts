import { describe, it, expect, vi } from "vitest";
import {
  listAllWorkerRoutes,
  createWorkerRoute,
  deleteWorkerRoute,
} from "../clients/worker-route-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const ROUTE = { id: "wr1", pattern: "a.com/api/*", script: "api-worker" };

function wrApi(over: Record<string, unknown> = {}) {
  const routes = {
    list: vi.fn(() => asyncIter([ROUTE])),
    create: vi.fn(async () => ROUTE),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { workers: { routes } }, ...over });
}

describe("worker-route-client", () => {
  it("listAllWorkerRoutes maps a route", async () => {
    const api = wrApi();
    const out = await listAllWorkerRoutes(api, "acct");
    expect(out[0].id).toBe("acct:worker-route:z1/wr1");
    expect(out[0].fields.pattern).toBe("a.com/api/*");
    expect(out[0].fields.script).toBe("api-worker");
  });

  it("createWorkerRoute sends pattern + script", async () => {
    const api = wrApi();
    await createWorkerRoute(
      api,
      "acct",
      { pattern: "a.com/api/*", scriptName: "api-worker" },
      "z1",
    );
    expect(api.cf.workers.routes.create).toHaveBeenCalledWith({
      zone_id: "z1",
      pattern: "a.com/api/*",
      script: "api-worker",
    });
  });

  it("createWorkerRoute throws without a zone", async () => {
    await expect(createWorkerRoute(wrApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("deleteWorkerRoute calls delete", async () => {
    const api = wrApi();
    await deleteWorkerRoute(api, "z1/wr1");
    expect(api.cf.workers.routes.delete).toHaveBeenCalledWith("wr1", { zone_id: "z1" });
  });

  it("deleteWorkerRoute throws on a malformed id", async () => {
    await expect(deleteWorkerRoute(wrApi(), "bad")).rejects.toThrow("Invalid worker route ID");
  });
});
