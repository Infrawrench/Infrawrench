import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudArmorContext } from "../cloud-armor-handlers.js";
import {
  fetchCloudArmorPolicyFull,
  listCloudArmorTargets,
  executeCloudArmorCommand,
} from "../cloud-armor-handlers.js";

const ctx: CloudArmorContext = { project: "proj", token: async () => "tok" };

function res(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:cloud-armor-policy:proj/pol",
    pluginId: "gcp",
    resourceTypeId: "cloud-armor-policy",
    accountId: "acct",
    displayName: "pol",
    fields: { name: "pol" },
    resolvedOutputs: {},
    secretStates: [],
    externalId: "proj/pol",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  } as ResourceInstance;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchCloudArmorPolicyFull", () => {
  it("summarises basic + advanced rules, sorts by priority", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        fingerprint: "fp",
        rules: [
          { priority: 2000, action: "allow", match: { expr: { expression: "true" } } },
          {
            priority: 1000,
            action: "deny(403)",
            preview: true,
            match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["1.2.3.0/24"] } },
          },
        ],
      }),
    );
    const out = await fetchCloudArmorPolicyFull(ctx, res());
    expect(out.rules[0]!.priority).toBe(1000);
    expect(out.rules[0]!.mode).toBe("basic");
    expect(out.rules[0]!.responseCode).toBe("403");
    expect(out.rules[1]!.mode).toBe("advanced");
    expect(out.fingerprint).toBe("fp");
  });

  it("uses fields.name when externalId has no slash; error path", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const out = await fetchCloudArmorPolicyFull(ctx, res({ externalId: "pol" }));
    expect(out.error).toContain("GCP Compute API 500");
  });
});

describe("listCloudArmorTargets", () => {
  it("filters backend services by securityPolicy suffix", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        items: {
          global: {
            backendServices: [
              { name: "bs1", securityPolicy: "https://x/securityPolicies/pol" },
              { name: "bs2", securityPolicy: "https://x/securityPolicies/other" },
            ],
          },
          "regions/us-central1": {
            backendServices: [{ name: "bs3", securityPolicy: "https://x/securityPolicies/pol" }],
          },
        },
      }),
    );
    const out = await listCloudArmorTargets(ctx, res());
    expect(out.targets).toHaveLength(2);
    const bs3 = out.targets.find((t) => t.name === "bs3");
    expect(bs3!.region).toBe("us-central1");
  });

  it("error path", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 403 }));
    expect((await listCloudArmorTargets(ctx, res())).error).toContain("GCP Compute API 403");
  });
});

describe("executeCloudArmorCommand", () => {
  it("addRule basic builds srcIpRanges + posts to addRule", async () => {
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudArmorCommand(ctx, res(), "addRule", [
      JSON.stringify({
        priority: "900",
        description: "d",
        mode: "basic",
        match: "1.2.3.0/24, 4.5.6.0/24",
        action: "deny",
        responseCode: "404",
        preview: "true",
      }),
    ]);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("/securityPolicies/pol/addRule");
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.match.config.srcIpRanges).toEqual(["1.2.3.0/24", "4.5.6.0/24"]);
    expect(body.action).toBe("deny(404)");
    expect(body.preview).toBe(true);
  });

  it("addRule advanced uses expr + allow; empty match falls back to ['*']", async () => {
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudArmorCommand(ctx, res(), "addRule", [
      JSON.stringify({ mode: "advanced", match: "origin.region_code == 'US'", action: "allow" }),
    ]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.match.expr.expression).toBe("origin.region_code == 'US'");
    expect(body.action).toBe("allow");

    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudArmorCommand(ctx, res(), "addRule", [
      JSON.stringify({ mode: "basic", match: "", action: "deny" }),
    ]);
    expect(
      JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string).match.config
        .srcIpRanges,
    ).toEqual(["*"]);
  });

  it("addRule error propagates", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 400 }));
    await expect(
      executeCloudArmorCommand(ctx, res(), "addRule", [
        JSON.stringify({ priority: "1", match: "*" }),
      ]),
    ).rejects.toThrow("GCP Compute API 400");
  });

  it("deleteRule posts removeRule with priority", async () => {
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudArmorCommand(ctx, res(), "deleteRule", [
      JSON.stringify({ priority: "1000" }),
    ]);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/removeRule?priority=1000");
  });

  it("addTarget global + regional sets securityPolicy", async () => {
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudArmorCommand(ctx, res(), "addTarget", [
      JSON.stringify({ backendService: "bs1", region: "" }),
    ]);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(
      "/global/backendServices/bs1/setSecurityPolicy",
    );
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).securityPolicy,
    ).toContain("/securityPolicies/pol");

    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudArmorCommand(ctx, res(), "addTarget", [
      JSON.stringify({ backendService: "bs3", region: "us-central1" }),
    ]);
    expect(String(fetchSpy.mock.calls[1]![0])).toContain(
      "/regions/us-central1/backendServices/bs3/setSecurityPolicy",
    );
  });

  it("removeTarget nulls securityPolicy + error", async () => {
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudArmorCommand(ctx, res(), "removeTarget", [
      JSON.stringify({ backendService: "bs1", region: "" }),
    ]);
    expect(
      JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).securityPolicy,
    ).toBeNull();
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(
      executeCloudArmorCommand(ctx, res(), "removeTarget", [
        JSON.stringify({ backendService: "bs1" }),
      ]),
    ).rejects.toThrow("GCP Compute API 500");
  });

  it("unknown command throws", async () => {
    await expect(executeCloudArmorCommand(ctx, res(), "noSuch", [])).rejects.toThrow(
      "Unknown Cloud Armor command",
    );
  });
});
