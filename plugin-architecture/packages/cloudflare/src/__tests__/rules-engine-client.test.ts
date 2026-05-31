import { describe, it, expect, vi } from "vitest";
import {
  listAllPhaseRules,
  createPhaseRule,
  editPhaseRule,
  deletePhaseRule,
  RATE_LIMIT_SPEC,
  REDIRECT_SPEC,
  CACHE_SPEC,
} from "../clients/rules-engine-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

function rsApi(ruleset: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  const rulesets = {
    list: vi.fn(() => asyncIter(ruleset ? [ruleset] : [])),
    get: vi.fn(async () => ruleset),
    create: vi.fn(async () => ruleset ?? { id: "rsNew", rules: [{ id: "ruleN" }] }),
    rules: {
      create: vi.fn(async () => ruleset),
      edit: vi.fn(async () => ruleset),
      delete: vi.fn(async () => undefined),
    },
  };
  return makeApi({ cf: { rulesets }, ...over });
}

describe("rules-engine-client generic", () => {
  it("listAllPhaseRules reads rules of the matching phase", async () => {
    const ruleset = {
      id: "rs1",
      phase: "http_ratelimit",
      rules: [
        {
          id: "r1",
          description: "limit",
          expression: "true",
          action: "block",
          enabled: true,
          ratelimit: { requests_per_period: 100, period: 60, characteristics: ["ip.src"] },
        },
      ],
    };
    const api = rsApi(ruleset);
    const out = await listAllPhaseRules(api, "acct", RATE_LIMIT_SPEC);
    expect(out[0]!.id).toBe("acct:rate-limit-rule:z1/rs1/r1");
    expect(out[0]!.parentResourceId).toBe("acct:zone:z1");
    expect(out[0]!.fields.requestsPerPeriod).toBe(100);
    expect(out[0]!.fields.characteristics).toBe("ip.src");
  });

  it("listAllPhaseRules returns empty when phase ruleset absent", async () => {
    const api = rsApi({ id: "x", phase: "other" });
    expect(await listAllPhaseRules(api, "acct", RATE_LIMIT_SPEC)).toEqual([]);
  });

  it("createPhaseRule appends to an existing ruleset", async () => {
    const ruleset = { id: "rs1", phase: "http_ratelimit", rules: [{ id: "r1" }] };
    const api = rsApi(ruleset);
    const out = await createPhaseRule(
      api,
      "acct",
      RATE_LIMIT_SPEC,
      { description: "limit", expression: "true" },
      "z1",
    );
    expect(api.cf.rulesets.rules.create).toHaveBeenCalledWith(
      "rs1",
      expect.objectContaining({ zone_id: "z1" }),
    );
    expect(out.externalId).toBe("z1/rs1/r1");
  });

  it("createPhaseRule creates the entrypoint ruleset when none exists", async () => {
    const api = rsApi(null);
    const out = await createPhaseRule(api, "acct", REDIRECT_SPEC, { target: "/x" }, "z1");
    expect(api.cf.rulesets.create).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "http_request_dynamic_redirect" }),
    );
    expect(out.externalId).toBe("z1/rsNew/ruleN");
  });

  it("createPhaseRule throws without a zone", async () => {
    await expect(createPhaseRule(rsApi(null), "acct", CACHE_SPEC, {}, "")).rejects.toThrow(
      /zoneId is required/,
    );
  });

  it("editPhaseRule edits a rule in place", async () => {
    const ruleset = { id: "rs1", rules: [{ id: "r1" }] };
    const api = rsApi(ruleset);
    await editPhaseRule(api, "acct", CACHE_SPEC, "z1/rs1/r1", { description: "x" });
    expect(api.cf.rulesets.rules.edit).toHaveBeenCalledWith(
      "rs1",
      "r1",
      expect.objectContaining({ zone_id: "z1" }),
    );
  });

  it("editPhaseRule throws on a malformed id", async () => {
    await expect(editPhaseRule(rsApi(null), "acct", CACHE_SPEC, "bad", {})).rejects.toThrow(
      "Invalid rule ID",
    );
  });

  it("deletePhaseRule calls delete", async () => {
    const api = rsApi(null);
    await deletePhaseRule(api, "z1/rs1/r1");
    expect(api.cf.rulesets.rules.delete).toHaveBeenCalledWith("rs1", "r1", { zone_id: "z1" });
  });

  it("deletePhaseRule throws on a malformed id", async () => {
    await expect(deletePhaseRule(rsApi(null), "bad")).rejects.toThrow("Invalid rule ID");
  });
});

describe("rules-engine specs", () => {
  it("RATE_LIMIT_SPEC builds a ratelimit body and display name", () => {
    const body = RATE_LIMIT_SPEC.buildBody({
      description: "",
      expression: "true",
      characteristics: "ip.src, http.host",
      period: "120",
      requestsPerPeriod: "50",
    });
    expect(body.ratelimit).toMatchObject({
      characteristics: ["ip.src", "http.host"],
      period: 120,
      requests_per_period: 50,
      mitigation_timeout: 120,
    });
    expect(RATE_LIMIT_SPEC.displayName({}, { requestsPerPeriod: 50, period: 60 })).toBe("50/60s");
  });

  it("REDIRECT_SPEC maps and builds redirect rules", () => {
    const fields = REDIRECT_SPEC.mapFields({
      description: "go",
      expression: "true",
      action: "redirect",
      enabled: true,
      action_parameters: {
        from_value: {
          target_url: { value: "/new" },
          status_code: 301,
          preserve_query_string: true,
        },
      },
    });
    expect(fields.target).toBe("/new");
    expect(fields.statusCode).toBe(301);
    expect(fields.preserveQuery).toBe(true);
    const body = REDIRECT_SPEC.buildBody({
      target: "/new",
      statusCode: "302",
      preserveQuery: "true",
    });
    expect(
      (body.action_parameters as Record<string, Record<string, unknown>>).from_value!.status_code,
    ).toBe(302);
    expect(REDIRECT_SPEC.displayName({}, { target: "/new" })).toBe("/new");
  });

  it("CACHE_SPEC attaches edge_ttl only when caching and value given", () => {
    const on = CACHE_SPEC.buildBody({ cache: "true", edgeTtl: "300" });
    expect((on.action_parameters as Record<string, unknown>).edge_ttl).toEqual({
      mode: "override_origin",
      default: 300,
    });
    const off = CACHE_SPEC.buildBody({ cache: "false" });
    expect((off.action_parameters as Record<string, unknown>).edge_ttl).toBeUndefined();
    expect((off.action_parameters as Record<string, unknown>).cache).toBe(false);
    expect(CACHE_SPEC.displayName({}, { cache: false })).toBe("Bypass cache");
    const mapped = CACHE_SPEC.mapFields({
      action_parameters: { cache: true, edge_ttl: { default: 60 } },
    });
    expect(mapped.cache).toBe(true);
    expect(mapped.edgeTtl).toBe(60);
  });
});
