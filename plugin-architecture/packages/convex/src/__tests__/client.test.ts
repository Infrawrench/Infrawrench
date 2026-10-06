import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { ConvexApiError, statusOf } from "../api.js";
import { ConvexClient, logStreamBody, usageLimitBody } from "../client.js";
import { siteUrlOf } from "../mappers.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

type Route = (call: Call) => { status: number; body: unknown } | undefined;

function fake(routes: Route[]) {
  const calls: Call[] = [];
  const services: HostServices = {
    http: {
      async request(req) {
        const call: Call = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
        };
        calls.push(call);
        for (const route of routes) {
          const res = route(call);
          if (res) return { status: res.status, headers: {}, body: JSON.stringify(res.body) };
        }
        return {
          status: 404,
          headers: {},
          body: JSON.stringify({ code: "NotFound", message: "nope" }),
        };
      },
    },
  };
  return { client: new ConvexClient({ accessToken: "tok" }, services), calls };
}

const on =
  (method: string, url: string | RegExp, body: unknown, status = 200): Route =>
  (call) => {
    const u = new URL(call.url);
    const target = `${u.origin}${u.pathname}`;
    const ok = typeof url === "string" ? target === url : url.test(target);
    return call.method === method && ok ? { status, body } : undefined;
  };

const API = "https://api.convex.dev/v1";
const teamToken = on("GET", `${API}/token_details`, {
  type: "teamToken",
  id: 1,
  teamId: 42,
  name: "t",
  createTime: 0,
});
const deployment = {
  kind: "cloud",
  id: 7,
  name: "happy-otter-123",
  createTime: 1_700_000_000_000,
  deploymentType: "prod",
  projectId: 9,
  region: "aws-eu-west-1",
  isDefault: true,
  reference: "production",
  deploymentUrl: "https://happy-otter-123.eu-west-1.convex.cloud",
  class: "s16",
};

describe("ConvexClient", () => {
  it("uses Bearer for the Management API and drains cursor pages", async () => {
    const { client, calls } = fake([
      teamToken,
      (call) => {
        const u = new URL(call.url);
        if (u.pathname !== "/v1/teams/42/projects") return undefined;
        const cursor = u.searchParams.get("cursor");
        return cursor
          ? {
              status: 200,
              body: {
                items: [
                  { id: 2, name: "B", slug: "b", teamId: 42, teamSlug: "acme", createTime: 1 },
                ],
                pagination: { hasMore: false },
              },
            }
          : {
              status: 200,
              body: {
                items: [
                  { id: 1, name: "A", slug: "a", teamId: 42, teamSlug: "acme", createTime: 1 },
                ],
                pagination: { hasMore: true, nextCursor: "c2" },
              },
            };
      },
    ]);
    const projects = await client.listResources("convex-project", ACCOUNT);
    expect(projects.map((p) => p.externalId)).toEqual(["1", "2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
  });

  it("rejects tokens that are not team tokens", async () => {
    const { client } = fake([
      on("GET", `${API}/token_details`, {
        type: "projectToken",
        id: 1,
        projectId: 3,
        name: "p",
        createTime: 0,
      }),
    ]);
    const err = await client.listResources("convex-project", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexApiError);
    expect((err as Error).message).toMatch(/not a team access token/);
  });

  it("maps error bodies to status and code", async () => {
    const { client } = fake([
      teamToken,
      on("GET", `${API}/teams/42/projects`, { code: "Forbidden", message: "no" }, 403),
    ]);
    const err = await client.listResources("convex-project", ACCOUNT).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(403);
    expect((err as ConvexApiError).code).toBe("Forbidden");
  });

  it("calls the Deployment API on the deployment's own URL with the Convex scheme", async () => {
    const { client, calls } = fake([
      teamToken,
      on("GET", `${API}/teams/42/list_deployments`, {
        items: [
          deployment,
          {
            kind: "local",
            name: "local-x",
            projectId: 9,
            createTime: 0,
            deploymentType: "dev",
            port: 3210,
          },
        ],
        pagination: { hasMore: false },
      }),
      on("GET", `${deployment.deploymentUrl}/api/v1/list_environment_variables`, {
        environmentVariables: { B: "2", A: "1" },
      }),
    ]);
    const vars = await client.listResources("convex-env-var", ACCOUNT);
    expect(vars.map((v) => v.externalId)).toEqual(["happy-otter-123/A", "happy-otter-123/B"]);
    const deploymentCall = calls.find((c) => c.url.includes("/api/v1/"))!;
    expect(deploymentCall.headers["Authorization"]).toBe("Convex tok");
    expect(calls.some((c) => c.url.includes("local-x"))).toBe(false);
  });

  it("deletes an environment variable by setting it to null", async () => {
    const { client, calls } = fake([
      on("GET", `${API}/deployments/happy-otter-123`, deployment),
      on("POST", `${deployment.deploymentUrl}/api/v1/update_environment_variables`, {}),
    ]);
    await client.deleteResource(
      "convex-env-var",
      `${ACCOUNT}:convex-env-var:happy-otter-123/SECRET`,
      ACCOUNT,
    );
    expect(JSON.parse(String(calls.at(-1)!.body))).toEqual({
      changes: [{ name: "SECRET", value: null }],
    });
  });

  it("reports enabled usage limits as quotas against current usage", async () => {
    const { client } = fake([
      teamToken,
      on("GET", `${API}/teams/42/list_deployments`, {
        items: [deployment],
        pagination: { hasMore: false },
      }),
      on("GET", `${deployment.deploymentUrl}/api/v1/list_usage_limits`, {
        usageLimits: [
          {
            id: "l1",
            metric: "functionCalls",
            window: "month",
            limitType: "warning",
            limit: 1000,
            enabled: true,
          },
          {
            id: "l2",
            metric: "dataEgressGb",
            window: "day",
            limitType: "disable",
            limit: 5,
            enabled: false,
          },
        ],
      }),
      on("GET", `${deployment.deploymentUrl}/api/v1/get_current_usage`, {
        metrics: {
          functionCalls: { unit: "calls", usage: { current_day: 10, current_month: 250 } },
        },
        seedStatus: "complete",
      }),
    ]);
    const quotas = await client.fetchQuotas(ACCOUNT);
    expect(quotas).toHaveLength(1);
    expect(quotas[0]).toMatchObject({
      id: "happy-otter-123/l1",
      used: 250,
      limit: 1000,
      unit: "calls",
    });
  });

  it("returns the deploy key only from the create call", async () => {
    const { client } = fake([
      on("POST", `${API}/deployments/happy-otter-123/create_deploy_key`, {
        deployKey: "prod:happy-otter-123|secret",
      }),
      on("GET", `${API}/deployments/happy-otter-123/list_deploy_keys`, [
        {
          id: 5,
          name: "ci",
          creationTime: 1_700_000_000_000,
          allowedActions: ["deployment:deploy"],
        },
      ]),
    ]);
    const created = await client.createResource(
      "convex-deploy-key",
      ACCOUNT,
      { name: "ci", allowedActions: '["deployment:deploy"]' },
      `${ACCOUNT}:convex-deployment:happy-otter-123`,
    );
    const resource = "resource" in created ? created.resource : created;
    expect(resource.externalId).toBe("happy-otter-123/5");
    expect(resource.resolvedOutputs["deployKey"]).toBe("prod:happy-otter-123|secret");
    await expect(
      client.resolveOutput("convex-deploy-key", resource.id, "deployKey", ACCOUNT),
    ).rejects.toThrow(/only when it is created/);
  });
});

describe("helpers", () => {
  it("builds log stream bodies per destination", () => {
    expect(
      logStreamBody({ streamType: "webhook", url: "https://x", topics: '["console"]' }),
    ).toEqual({
      logStreamType: "webhook",
      url: "https://x",
      format: "jsonl",
      topics: ["console"],
    });
    expect(logStreamBody({ streamType: "datadog", apiKey: "k", tags: "a, b" })).toMatchObject({
      siteLocation: "US1",
      ddApiKey: "k",
      ddTags: ["a", "b"],
    });
    expect(() => logStreamBody({ streamType: "sentry" })).toThrow(/DSN/);
  });

  it("validates usage limits", () => {
    expect(
      usageLimitBody({ metric: "functionCalls", limit: "10", window: "day", limitType: "disable" }),
    ).toEqual({
      metric: "functionCalls",
      window: "day",
      limitType: "disable",
      limit: 10,
      enabled: true,
    });
    expect(() => usageLimitBody({ metric: "functionCalls", limit: "0" })).toThrow();
  });

  it("derives the HTTP actions host", () => {
    expect(siteUrlOf("https://happy-otter-123.eu-west-1.convex.cloud")).toBe(
      "https://happy-otter-123.eu-west-1.convex.site",
    );
  });

  it("treats plan-tier components as provider-wide and ignores the website", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "i",
            name: "Elevated latency",
            status: "investigating",
            impact: "minor",
            created_at: "2026-10-06T00:00:00Z",
            updated_at: "2026-10-06T00:00:00Z",
            components: [{ name: "Professional" }],
            incident_updates: [],
          },
        ],
      }),
    );
    expect(incidents[0]!.providerWide).toBe(true);
  });
});
