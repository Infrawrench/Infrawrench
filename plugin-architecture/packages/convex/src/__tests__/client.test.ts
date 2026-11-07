import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
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
  return { client: hostClient(new ConvexClient({ accessToken: "tok" }, services)), calls };
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

describe("creating a key whose secret is shown once", () => {
  const down = { code: "Unavailable", message: "try later" };

  it("keeps a deploy key's secret when the list read after it fails", async () => {
    const { client } = fake([
      on("POST", `${API}/deployments/happy-otter-123/create_deploy_key`, {
        deployKey: "prod:happy-otter-123|secret",
      }),
      on("GET", `${API}/deployments/happy-otter-123/list_deploy_keys`, down, 503),
    ]);
    const created = await client.createResource(
      "convex-deploy-key",
      ACCOUNT,
      { name: "ci" },
      `${ACCOUNT}:convex-deployment:happy-otter-123`,
    );
    const resource = "resource" in created ? created.resource : created;
    expect(resource.externalId).toBe("happy-otter-123/ci");
    expect(resource.resolvedOutputs["deployKey"]).toBe("prod:happy-otter-123|secret");
  });

  it("keeps a deploy key's secret when that list comes back in the wrong shape", async () => {
    const { client } = fake([
      on("POST", `${API}/deployments/happy-otter-123/create_deploy_key`, {
        deployKey: "prod:happy-otter-123|secret",
      }),
      on("GET", `${API}/deployments/happy-otter-123/list_deploy_keys`, { keys: [] }),
    ]);
    const created = await client.createResource(
      "convex-deploy-key",
      ACCOUNT,
      { name: "ci" },
      `${ACCOUNT}:convex-deployment:happy-otter-123`,
    );
    const resource = "resource" in created ? created.resource : created;
    expect(resource.resolvedOutputs["deployKey"]).toBe("prod:happy-otter-123|secret");
  });

  it("keeps a preview deploy key's secret when the list read after it fails", async () => {
    const { client } = fake([
      on("POST", `${API}/projects/9/create_preview_deploy_key`, { previewDeployKey: "preview|s" }),
      on("GET", `${API}/projects/9/list_preview_deploy_keys`, down, 503),
    ]);
    const created = await client.createResource(
      "convex-preview-deploy-key",
      ACCOUNT,
      { name: "ci" },
      `${ACCOUNT}:convex-project:9`,
    );
    const resource = "resource" in created ? created.resource : created;
    expect(resource.externalId).toBe("9/ci");
    expect(resource.resolvedOutputs["previewDeployKey"]).toBe("preview|s");
  });
});

describe("lists that cannot say they are complete", () => {
  const PROJECTS = `${API}/teams/42/projects`;
  const project = { id: 1, name: "A", slug: "a", teamId: 42, teamSlug: "acme", createTime: 1 };
  const deployments = on("GET", `${API}/teams/42/list_deployments`, {
    items: [deployment],
    pagination: { hasMore: false },
  });
  const projects = on("GET", PROJECTS, { items: [project], pagination: { hasMore: false } });
  const onDeploymentApi = `${deployment.deploymentUrl}/api/v1`;

  it("throws at the page cap, after exactly that many requests", async () => {
    const { client, calls } = fake([
      teamToken,
      on("GET", PROJECTS, {
        items: [project],
        pagination: { hasMore: true, nextCursor: "again" },
      }),
    ]);
    await expect(client.listResources("convex-project", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => c.url.includes("/projects"))).toHaveLength(500);
  });

  it("throws on a renamed list key on the first page", async () => {
    const { client } = fake([
      teamToken,
      on("GET", PROJECTS, { projects: [project], pagination: { hasMore: false } }),
    ]);
    await expect(client.listResources("convex-project", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("throws on a renamed list key on a later page", async () => {
    const { client } = fake([
      teamToken,
      (call) => {
        const u = new URL(call.url);
        if (u.pathname !== "/v1/teams/42/projects") return undefined;
        return u.searchParams.get("cursor")
          ? { status: 200, body: { projects: [project], pagination: { hasMore: false } } }
          : {
              status: 200,
              body: { items: [project], pagination: { hasMore: true, nextCursor: "c" } },
            };
      },
    ]);
    await expect(client.listResources("convex-project", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads a list key set to null as an empty list", async () => {
    const { client } = fake([
      teamToken,
      on("GET", PROJECTS, { items: null, pagination: { hasMore: false } }),
    ]);
    await expect(client.listResources("convex-project", ACCOUNT)).resolves.toEqual([]);
  });

  it.each([
    ["convex-env-var", `${onDeploymentApi}/list_environment_variables`, { variables: {} }],
    ["convex-env-var", `${onDeploymentApi}/list_environment_variables`, "<html>sign in</html>"],
    ["convex-deploy-key", `${API}/deployments/happy-otter-123/list_deploy_keys`, { keys: [] }],
    ["convex-preview-deploy-key", `${API}/projects/1/list_preview_deploy_keys`, { keys: [] }],
    ["convex-custom-domain", `${API}/deployments/happy-otter-123/custom_domains`, { items: [] }],
    ["convex-log-stream", `${onDeploymentApi}/list_log_streams`, { streams: [] }],
    ["convex-usage-limit", `${onDeploymentApi}/list_usage_limits`, { limits: [] }],
  ])("throws rather than reading %s from %s answered with %j as empty", async (type, url, body) => {
    const { client } = fake([teamToken, deployments, projects, on("GET", url, body)]);
    await expect(client.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reports no quotas only when the limits list really says so", async () => {
    const { client } = fake([
      teamToken,
      deployments,
      on("GET", `${onDeploymentApi}/list_usage_limits`, { limits: [] }),
    ]);
    await expect(client.fetchQuotas(ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("does not call a deploy key gone because its list came back in the wrong shape", async () => {
    const { client, calls } = fake([
      on("GET", `${API}/deployments/happy-otter-123/list_deploy_keys`, { keys: [] }),
    ]);
    await expect(
      client.deleteResource(
        "convex-deploy-key",
        `${ACCOUNT}:convex-deploy-key:happy-otter-123/5`,
        ACCOUNT,
      ),
    ).rejects.toThrow("is not a list");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  const envVars = `${onDeploymentApi}/list_environment_variables`;
  const unavailable = { code: "Unavailable", message: "try later" };

  it("fails the list when an established deployment answers 503", async () => {
    const { client } = fake([teamToken, deployments, on("GET", envVars, unavailable, 503)]);
    const err = await client.listResources("convex-env-var", ACCOUNT).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(503);
  });

  it("fails the list when the Management API answers 503 for deploy keys", async () => {
    const { client } = fake([
      teamToken,
      deployments,
      on("GET", `${API}/deployments/happy-otter-123/list_deploy_keys`, unavailable, 503),
    ]);
    const err = await client.listResources("convex-deploy-key", ACCOUNT).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(503);
  });

  it("skips a deployment still provisioning, and one deleted mid-sync", async () => {
    const provisioning = { ...deployment, createTime: Date.now() - 60_000 };
    const fresh = fake([
      teamToken,
      on("GET", `${API}/teams/42/list_deployments`, {
        items: [provisioning],
        pagination: { hasMore: false },
      }),
      on("GET", envVars, unavailable, 503),
    ]);
    await expect(fresh.client.listResources("convex-env-var", ACCOUNT)).resolves.toEqual([]);

    const deleted = fake([teamToken, deployments, on("GET", envVars, unavailable, 404)]);
    await expect(deleted.client.listResources("convex-env-var", ACCOUNT)).resolves.toEqual([]);
  });

  it("lets an unreadable member list fail the team, but not a refused one", async () => {
    const members = `${API}/teams/42/list_members`;
    const invites = on("GET", `${API}/teams/42/list_pending_invites`, { items: [] });
    const renamed = fake([teamToken, projects, invites, on("GET", members, { members: [] })]);
    await expect(renamed.client.listResources("convex-team", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );

    const refused = fake([
      teamToken,
      projects,
      invites,
      on("GET", members, { code: "Forbidden", message: "no" }, 403),
    ]);
    const [team] = await refused.client.listResources("convex-team", ACCOUNT);
    expect(team!.fields["projectCount"]).toBe(1);
    expect(team!.fields).not.toHaveProperty("memberCount");
  });

  it("lets a truncated invite list fail the team too", async () => {
    const { client } = fake([
      teamToken,
      projects,
      on("GET", `${API}/teams/42/list_members`, { items: [] }),
      on("GET", `${API}/teams/42/list_pending_invites`, {
        items: [{ email: "a@example.com", role: "developer", expired: false }],
        pagination: { hasMore: true, nextCursor: "again" },
      }),
    ]);
    await expect(client.listResources("convex-team", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("uses the host's transport with no CA, and never fetch", async () => {
    const stub = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", stub);
    try {
      const { client, calls } = fake([teamToken, projects]);
      await client.listResources("convex-project", ACCOUNT);
      expect(calls.length).toBeGreaterThan(0);
      expect(stub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("custom roles", () => {
  const INVITE_ID = `${ACCOUNT}:convex-invite:42/ada@example.com`;
  const invites = (items: unknown[]) =>
    on("GET", `${API}/teams/42/list_pending_invites`, { items });
  const cancel = on("POST", `${API}/teams/42/cancel_team_member_invite`, {});
  const invite = on("POST", `${API}/teams/42/invite_team_member`, {});
  const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

  it("shows a member's custom roles by name", async () => {
    const { client } = fake([
      teamToken,
      on("GET", `${API}/teams/42/list_members`, {
        items: [
          {
            id: 1,
            email: "ada@example.com",
            role: "custom",
            customRoles: [
              { id: 3, name: "Billing" },
              { id: 4, name: "On call" },
            ],
          },
          { id: 2, email: "bob@example.com", role: "admin", customRoles: null },
        ],
      }),
    ]);
    const members = await client.listResources("convex-member", ACCOUNT);
    expect(members.map((m) => m.fields["customRoles"])).toEqual(["Billing, On call", ""]);
  });

  it("resends a custom-role invite with the role ids, not the listed objects", async () => {
    const { client, calls } = fake([
      invites([
        {
          email: "ada@example.com",
          role: "custom",
          expired: false,
          customRoles: [
            { id: 3, name: "Billing" },
            { id: 4, name: "On call" },
          ],
        },
      ]),
      cancel,
      invite,
    ]);
    await client.invokeAction("convex-invite", INVITE_ID, "resend", ACCOUNT);
    const [cancelled, sent] = posts(calls);
    expect(cancelled!.url).toContain("cancel_team_member_invite");
    expect(JSON.parse(String(sent!.body))).toEqual({
      email: "ada@example.com",
      role: "custom",
      customRoles: [3, 4],
    });
  });

  it("still resends if roles are listed as bare ids", async () => {
    const { client, calls } = fake([
      invites([{ email: "ada@example.com", role: "custom", expired: false, customRoles: [3] }]),
      cancel,
      invite,
    ]);
    await client.invokeAction("convex-invite", INVITE_ID, "resend", ACCOUNT);
    expect(JSON.parse(String(posts(calls)[1]!.body)).customRoles).toEqual([3]);
  });

  it("does not cancel an invite it cannot find, or invite someone as a developer instead", async () => {
    const { client, calls } = fake([invites([]), cancel, invite]);
    await expect(
      client.invokeAction("convex-invite", INVITE_ID, "resend", ACCOUNT),
    ).rejects.toThrow(/no longer pending/);
    expect(posts(calls)).toEqual([]);
  });

  it("does not cancel a custom-role invite it could not send again", async () => {
    const { client, calls } = fake([
      invites([{ email: "ada@example.com", role: "custom", expired: false, customRoles: [] }]),
      cancel,
      invite,
    ]);
    await expect(
      client.invokeAction("convex-invite", INVITE_ID, "resend", ACCOUNT),
    ).rejects.toThrow(/no custom roles/);
    expect(posts(calls)).toEqual([]);
  });

  it("says the invite is gone when sending it again fails", async () => {
    const { client } = fake([
      invites([{ email: "ada@example.com", role: "developer", expired: false }]),
      cancel,
      on("POST", `${API}/teams/42/invite_team_member`, { code: "Bad", message: "no" }, 400),
    ]);
    const err = await client
      .invokeAction("convex-invite", INVITE_ID, "resend", ACCOUNT)
      .catch((e: unknown) => e);
    expect(statusOf(err)).toBe(400);
    expect(String(err)).toMatch(
      /invite to ada@example\.com was cancelled but could not be sent again/,
    );
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
