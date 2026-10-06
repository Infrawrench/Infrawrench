import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderClient, buildServiceCreateBody, buildServicePatch, parseDotenv } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import { renderTerraformExport } from "../terraform.js";
import { installFetch, route, state } from "./helpers.js";
import type { RenderService } from "../types.js";

const ACCOUNT = "acct";

function client(creds: Record<string, string> = { apiKey: "rnd_key" }) {
  return new RenderClient(creds, RESOURCE_TYPES);
}

const WEB: RenderService = {
  id: "srv-web",
  name: "api",
  type: "web_service",
  ownerId: "tea-1",
  repo: "https://github.com/acme/api",
  branch: "main",
  autoDeployTrigger: "checksPass",
  suspended: "not_suspended",
  suspenders: [],
  dashboardUrl: "https://dashboard.render.com/web/srv-web",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  serviceDetails: {
    runtime: "node",
    plan: "standard",
    region: "oregon",
    numInstances: 2,
    url: "https://api.onrender.com",
    envSpecificDetails: { buildCommand: "npm ci", startCommand: "npm start" },
    autoscaling: {
      enabled: true,
      min: 1,
      max: 4,
      criteria: {
        cpu: { enabled: true, percentage: 60 },
        memory: { enabled: false, percentage: 70 },
      },
    },
  },
};

beforeEach(() => installFetch());
afterEach(() => vi.unstubAllGlobals());

describe("transport", () => {
  it("throws without an API key", () => {
    expect(() => new RenderClient({}, RESOURCE_TYPES)).toThrow(/missing apiKey/);
  });

  it("sends a bearer token and follows cursors across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      service: { ...WEB, id: `srv-${i}` },
      cursor: `c${i}`,
    }));
    route("GET", "/services", (call: { query: URLSearchParams }) =>
      call.query.get("cursor") === "c99" ? [{ service: WEB, cursor: "end" }] : page1,
    );
    const res = await client().listResources("service", ACCOUNT);
    expect(res).toHaveLength(101);
    expect(state.calls[0]!.headers["Authorization"]).toBe("Bearer rnd_key");
    expect(state.calls[0]!.query.get("limit")).toBe("100");
    expect(state.calls[1]!.query.get("cursor")).toBe("c99");
  });

  it("narrows every list to the configured workspace", async () => {
    route("GET", "/services", []);
    await client({ apiKey: "k", workspaceId: "tea-9" }).listResources("service", ACCOUNT);
    expect(state.calls[0]!.query.getAll("ownerId")).toEqual(["tea-9"]);
  });

  it("attaches the HTTP status to errors", async () => {
    route(
      "GET",
      "/services/srv-x",
      () => new Response(JSON.stringify({ message: "nope" }), { status: 403 }),
    );
    const err = await client()
      .getResource("service", `${ACCOUNT}:service:srv-x`, ACCOUNT)
      .catch((e: unknown) => e);
    expect((err as { status: number }).status).toBe(403);
    expect(String(err)).toContain("nope");
  });

  it("routes through the host HTTP service when present", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "[]" }));
    const c = new RenderClient({ apiKey: "k", caCert: "PEM" }, RESOURCE_TYPES, {
      http: { request },
    });
    await c.listResources("blueprint", ACCOUNT);
    expect(request).toHaveBeenCalledOnce();
    const [arg] = (request.mock.calls as unknown as Array<[{ caCert?: string; url: string }]>)[0]!;
    expect(arg.caCert).toBe("PEM");
    expect(arg.url).toContain("https://api.render.com/v1/blueprints");
  });
});

describe("mappers", () => {
  it("maps a web service with autoscaling and outputs", async () => {
    route("GET", "/services", [{ service: WEB, cursor: "x" }]);
    const [svc] = await client().listResources("service", ACCOUNT);
    expect(svc!.id).toBe("acct:service:srv-web");
    expect(svc!.fields).toMatchObject({
      serviceType: "web_service",
      status: "active",
      plan: "standard",
      region: "oregon",
      autoDeploy: "checksPass",
      buildCommand: "npm ci",
      startCommand: "npm start",
      autoscalingEnabled: true,
      autoscalingCpuPercent: 60,
    });
    expect(svc!.fields["autoscalingMemoryPercent"]).toBeUndefined();
    expect(svc!.resolvedOutputs["hostname"]).toBe("api.onrender.com");
  });

  it("lists deploys per service as scoped children", async () => {
    route("GET", "/services", [{ service: WEB, cursor: "x" }]);
    route("GET", "/services/srv-web/deploys", [
      {
        deploy: {
          id: "dep-1",
          status: "live",
          commit: { id: "abcdef123456", message: "Fix bug\n\nbody" },
        },
        cursor: "x",
      },
    ]);
    const [d] = await client().listResources("deploy", ACCOUNT);
    expect(d!.externalId).toBe("srv-web/dep-1");
    expect(d!.parentResourceId).toBe("acct:service:srv-web");
    expect(d!.displayName).toBe("abcdef1 Fix bug");
  });

  it("flags Postgres open to the internet and keeps connection strings out of fields", async () => {
    route("GET", "/postgres", [
      {
        postgres: {
          id: "dpg-1",
          name: "db",
          status: "available",
          plan: "basic_1gb",
          region: "ohio",
          version: "17",
          owner: { id: "tea-1" },
          ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "everywhere" }],
          readReplicas: [],
        },
        cursor: "x",
      },
    ]);
    const [pg] = await client().listResources("postgres", ACCOUNT);
    expect(pg!.fields["openToInternet"]).toBe(true);
    expect(pg!.fields["allowedCidrs"]).toBe("0.0.0.0/0");
    expect(JSON.stringify(pg!.fields)).not.toContain("postgres://");
  });

  it("resolves connection strings on demand", async () => {
    route("GET", "/postgres/dpg-1/connection-info", {
      externalConnectionString: "postgresql://u:p@host/db",
      internalConnectionString: "postgresql://u:p@dpg-1/db",
      password: "p",
    });
    const c = client();
    expect(
      await c.resolveOutput("postgres", "acct:postgres:dpg-1", "connectionString", ACCOUNT),
    ).toBe("postgresql://u:p@host/db");
    expect(await c.resolveOutput("postgres", "acct:postgres:dpg-1", "password", ACCOUNT)).toBe("p");
  });

  it("reads unwrapped environment group lists", async () => {
    route("GET", "/env-groups", [
      {
        id: "evg-1",
        name: "shared",
        ownerId: "tea-1",
        serviceLinks: [{ id: "srv-web", name: "api", type: "web" }],
      },
    ]);
    const [g] = await client().listResources("env-group", ACCOUNT);
    expect(g!.fields["linkedServiceIds"]).toBe("srv-web");
  });
});

describe("writes", () => {
  it("builds a native-runtime web service body", () => {
    const body = buildServiceCreateBody(
      {
        type: "web_service",
        name: "api",
        runtime: "node",
        repo: "https://github.com/acme/api",
        branch: "main",
        plan: "1c-2g",
        region: "frankfurt",
        buildCommand: "npm ci",
        startCommand: "npm start",
        healthCheckPath: "/healthz",
        autoDeploy: "commit",
      },
      "tea-1",
    );
    expect(body).toEqual({
      type: "web_service",
      name: "api",
      ownerId: "tea-1",
      repo: "https://github.com/acme/api",
      branch: "main",
      autoDeployTrigger: "commit",
      serviceDetails: {
        runtime: "node",
        plan: "1c-2g",
        region: "frankfurt",
        envSpecificDetails: { buildCommand: "npm ci", startCommand: "npm start" },
        healthCheckPath: "/healthz",
      },
    });
  });

  it("builds an image-backed cron job body and rejects a missing schedule", () => {
    const fields = { type: "cron_job", name: "nightly", runtime: "image", imageUrl: "acme/job:1" };
    expect(() => buildServiceCreateBody(fields, "tea-1")).toThrow(/cron schedule/);
    const body = buildServiceCreateBody({ ...fields, schedule: "0 3 * * *" }, "tea-1");
    expect(body["image"]).toEqual({ ownerId: "tea-1", imagePath: "acme/job:1" });
    expect((body["serviceDetails"] as Record<string, unknown>)["schedule"]).toBe("0 3 * * *");
  });

  it("patches only changed service settings, keeping the other command", () => {
    const patch = buildServicePatch(WEB, { startCommand: "node server.js", plan: "pro" });
    expect(patch).toEqual({
      serviceDetails: {
        plan: "pro",
        envSpecificDetails: { buildCommand: "npm ci", startCommand: "node server.js" },
      },
    });
  });

  it("scales and configures autoscaling through prompt commands", async () => {
    route("POST", "/services/srv-web/scale", undefined);
    route("PUT", "/services/srv-web/autoscaling", {});
    const c = client();
    await c.executeNoSqlCommand("service", "acct:service:srv-web", ACCOUNT, "scale", [
      JSON.stringify({ numInstances: "3" }),
    ]);
    await c.executeNoSqlCommand("service", "acct:service:srv-web", ACCOUNT, "autoscaling", [
      JSON.stringify({ enabled: "true", min: "1", max: "5", cpuPercent: "70", memoryPercent: "" }),
    ]);
    expect(state.calls[0]!.body).toEqual({ numInstances: 3 });
    expect(state.calls[1]!.body).toEqual({
      enabled: true,
      min: 1,
      max: 5,
      criteria: {
        cpu: { enabled: true, percentage: 70 },
        memory: { enabled: false, percentage: 70 },
      },
    });
  });

  it("rolls back to a deploy by id", async () => {
    route("POST", "/services/srv-web/rollback", { id: "dep-3" });
    await client().invokeAction("deploy", "acct:deploy:srv-web/dep-1", "rollback", ACCOUNT);
    expect(state.calls[0]!.body).toEqual({ deployId: "dep-1" });
  });

  it("parses dotenv lines", () => {
    expect(parseDotenv('# c\nA=1\nexport B="two"\n\nbad\n')).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two" },
    ]);
  });
});

describe("logs and metrics", () => {
  it("tails logs newest-first with the owner and resource", async () => {
    route("GET", "/services/srv-web", WEB);
    route("GET", "/logs", {
      hasMore: false,
      logs: [
        {
          message: "second",
          timestamp: "2026-01-01T00:00:02Z",
          labels: [{ name: "level", value: "info" }],
        },
        { message: "first", timestamp: "2026-01-01T00:00:01Z", labels: [] },
      ],
    });
    const res = await client().getLogs("service", "acct:service:srv-web", ACCOUNT, {
      tailLines: 50,
    });
    const logCall = state.calls.find((c) => c.path === "/logs")!;
    expect(logCall.query.get("ownerId")).toBe("tea-1");
    expect(logCall.query.getAll("resource")).toEqual(["srv-web"]);
    expect(logCall.query.get("direction")).toBe("backward");
    expect(res.text.split("\n")[0]).toContain("first");
    expect(res.text).toContain("INFO second");
  });

  it("returns web-service metrics and skips ones that fail", async () => {
    route("GET", "/services", [{ service: WEB, cursor: "x" }]);
    route("GET", "/metrics/cpu", [
      { labels: [], unit: "cpu", values: [{ timestamp: "2026-01-01T00:00:00Z", value: 0.5 }] },
    ]);
    route("GET", "/metrics/memory", [
      {
        labels: [],
        unit: "bytes",
        values: [{ timestamp: "2026-01-01T00:00:00Z", value: 1048576 }],
      },
    ]);
    const series = await client().fetchMetricSeries("service", "acct:service:srv-web", ACCOUNT);
    expect(series.map((s) => s.label)).toEqual(["CPU", "Memory"]);
    expect(series[1]!.points[0]!.value).toBe(1);
  });
});

describe("status feed", () => {
  it("maps grouped components to regions", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "inc1",
          name: "Degraded deploys",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-03T19:35:03Z",
          components: [
            { name: "Builds and Deploys", group_id: "4r7rv784cclm" },
            { name: "Render Dashboard", group_id: null },
          ],
          incident_updates: [],
        },
      ],
    });
    const [inc] = parseStatusFeed(body);
    expect(inc!.regions).toEqual(["oregon"]);
    expect(inc!.providerWide).toBe(true);
  });
});

describe("terraform", () => {
  it("maps a native web service", async () => {
    route("GET", "/services", [{ service: WEB, cursor: "x" }]);
    const [svc] = await client().listResources("service", ACCOUNT);
    const out = renderTerraformExport.mapResource(svc!);
    expect(out?.resource.type).toBe("render_web_service");
    expect(out?.resource.importId).toBe("srv-web");
    expect(out?.resource.attributes["autoscaling"]).toBeDefined();
  });
});

describe("credential options", () => {
  it("lists workspaces for the picker", async () => {
    route("GET", "/owners", [
      { owner: { id: "tea-1", name: "Acme", type: "team", email: "a@b.c" }, cursor: "x" },
    ]);
    const opts = await plugin.listCredentialOptions!("workspaceId", { apiKey: "k" });
    expect(opts).toEqual([{ id: "tea-1", label: "Acme", description: "Team · tea-1" }]);
  });
});
