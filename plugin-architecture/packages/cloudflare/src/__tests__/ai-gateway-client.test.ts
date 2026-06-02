import { describe, it, expect, vi } from "vitest";
import {
  listAiGateways,
  getAiGateway,
  createAiGateway,
  editAiGateway,
  deleteAiGateway,
} from "../clients/ai-gateway-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const GATEWAY = {
  id: "my-gateway",
  cache_ttl: 3600,
  cache_invalidate_on_update: true,
  collect_logs: true,
  rate_limiting_limit: 100,
  rate_limiting_interval: 60,
  rate_limiting_technique: "sliding",
  authentication: false,
  logpush: true,
  created_at: "2020-01-01T00:00:00Z",
  modified_at: "2020-01-02T00:00:00Z",
};

function gwApi(over: Record<string, unknown> = {}) {
  const aiGateway = {
    list: vi.fn(() => asyncIter([GATEWAY])),
    get: vi.fn(async () => GATEWAY),
    create: vi.fn(async () => GATEWAY),
    update: vi.fn(async () => GATEWAY),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { aiGateway }, ...over });
}

describe("ai-gateway-client", () => {
  it("listAiGateways maps fields and stamps the output", async () => {
    const api = gwApi();
    const out = await listAiGateways(api, "acct");
    expect(out[0]!.id).toBe("acct:ai-gateway:my-gateway");
    expect(out[0]!.externalId).toBe("my-gateway");
    expect(out[0]!.fields.cacheTtl).toBe("3600");
    expect(out[0]!.fields.collectLogs).toBe("true");
    expect(out[0]!.fields.authentication).toBe("false");
    expect(out[0]!.resolvedOutputs.gatewayId).toBe("my-gateway");
  });

  it("listAiGateways surfaces a permission hint on a 403", async () => {
    const api = makeApi({
      cf: {
        aiGateway: {
          list: vi.fn(() => {
            throw { status: 403 };
          }),
        },
      },
    });
    await expect(listAiGateways(api, "acct")).rejects.toThrow(/AI Gateway:Read permission/);
  });

  it("getAiGateway fetches by id", async () => {
    const api = gwApi();
    const out = await getAiGateway(api, "my-gateway", "acct");
    expect(api.cf.aiGateway.get).toHaveBeenCalledWith("my-gateway", { account_id: "acct-cf" });
    expect(out.fields.id).toBe("my-gateway");
  });

  it("createAiGateway coerces booleans and nullable numbers", async () => {
    const api = gwApi();
    await createAiGateway(api, "acct", {
      id: "g2",
      collectLogs: "true",
      cacheTtl: "600",
      cacheInvalidateOnUpdate: "false",
      rateLimitingLimit: "",
      rateLimitingInterval: "",
      authentication: "true",
      logpush: "false",
    });
    expect(api.cf.aiGateway.create).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-cf",
        id: "g2",
        collect_logs: true,
        cache_ttl: 600,
        cache_invalidate_on_update: false,
        rate_limiting_limit: null,
        rate_limiting_interval: null,
        authentication: true,
        logpush: false,
      }),
    );
    // No technique key when no rate limit is configured.
    expect(vi.mocked(api.cf.aiGateway.create).mock.calls[0]![0]).not.toHaveProperty(
      "rate_limiting_technique",
    );
  });

  it("editAiGateway sends the merged state and rate-limit technique", async () => {
    const api = gwApi();
    await editAiGateway(api, "acct", "my-gateway", {
      collectLogs: "false",
      cacheTtl: "1800",
      cacheInvalidateOnUpdate: "true",
      rateLimitingLimit: "50",
      rateLimitingInterval: "30",
      rateLimitingTechnique: "fixed",
      authentication: "false",
      logpush: "true",
    });
    expect(api.cf.aiGateway.update).toHaveBeenCalledWith(
      "my-gateway",
      expect.objectContaining({
        collect_logs: false,
        cache_ttl: 1800,
        rate_limiting_limit: 50,
        rate_limiting_technique: "fixed",
        logpush: true,
      }),
    );
  });

  it("deleteAiGateway calls delete with the account id", async () => {
    const api = gwApi();
    await deleteAiGateway(api, "my-gateway");
    expect(api.cf.aiGateway.delete).toHaveBeenCalledWith("my-gateway", { account_id: "acct-cf" });
  });
});
