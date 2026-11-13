import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoatClient, parseEvents, parsePorts, ttlOf } from "../client.js";
import { activeWindow } from "../cost-data.js";
import { envVarNames, parseEnv, parseLabels, sshCommand } from "../mappers.js";
import { quotasFrom } from "../quotas.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { sizeOptions } from "../create-config.js";
import { parseStatusFeed } from "../status-feed.js";
import type { BLimits } from "../types.js";

interface Call {
  method: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}
type Route = (call: Call) => unknown;
let calls: Call[] = [];
let routes: Record<string, Route> = {};

function route(method: string, path: string, handler: Route | unknown) {
  routes[`${method} ${path}`] = typeof handler === "function" ? (handler as Route) : () => handler;
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const call: Call = {
        method: init.method ?? "GET",
        url: u,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const handler = routes[`${call.method} ${u.pathname.replace(/^\/api\/v1/, "")}`];
      if (!handler) {
        return new Response(
          JSON.stringify({ ok: false, status: 404, code: "not_found", message: "Not found" }),
          { status: 404 },
        );
      }
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const client = (org = "") =>
  hostClient(new BoatClient({ apiKey: "boat_k", ...(org ? { org } : {}) }, RESOURCE_TYPES));

const SANDBOX = {
  id: "bx_23456789",
  name: "agent-run",
  state: "running",
  type: "default",
  vcpu: 4,
  memoryGB: 8,
  billingMultiplier: 1,
  ip: "203.0.113.10",
  sshEndpoint: "203.0.113.10:22001",
  url: "https://bx-23456789.boat.dev",
  desktopUrl: "https://desktop/?t=secret",
  ttlSeconds: null,
  labels: { team: "ml" },
  team: { id: "team_1", name: "Acme" },
  access: "owner",
  visibility: "private",
  desktopAvailable: true,
  snapshotAvailable: true,
  cost: { since: "2026-11-01T00:00:00Z", seconds: 3600, dollars: 0.036 },
  createdAt: "2026-11-10T12:00:00Z",
};

describe("sandboxes", () => {
  it("walks every page with costs and sends the organization header", async () => {
    route("GET", "/sandboxes", (c: Call) =>
      c.url.searchParams.get("cursor")
        ? {
            ok: true,
            sandboxes: [{ ...SANDBOX, id: "bx_3456789a" }],
            pageInfo: { hasMore: false, nextCursor: null, limit: 200 },
          }
        : {
            ok: true,
            sandboxes: [SANDBOX],
            pageInfo: { hasMore: true, nextCursor: "c2", limit: 200 },
          },
    );
    const rows = await client("team_1").listResources("sandbox", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["bx_23456789", "bx_3456789a"]);
    expect(calls[0]!.url.searchParams.get("include")).toBe("cost");
    expect(calls[0]!.headers["X-Boat-Org"]).toBe("team_1");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer boat_k");
    const r = rows[0]!;
    expect(r.fields["online"]).toBe(true);
    expect(r.fields["autoStopDisabled"]).toBe(true);
    expect(r.fields["monthCost"]).toBe(0.036);
    expect(r.fields["labels"]).toBe("team=ml");
    expect(r.resolvedOutputs["sshCommand"]).toBe("ssh -p 22001 user@203.0.113.10");
    // The desktop URL carries a token and is never stored with the inventory.
    expect(r.resolvedOutputs["desktopUrl"]).toBeUndefined();
  });

  it("throws on a page with no list rather than reading it as empty", async () => {
    route("GET", "/sandboxes", {
      ok: true,
      pageInfo: { hasMore: false, nextCursor: null, limit: 200 },
    });
    await expect(client().listResources("sandbox", "acct")).rejects.toThrow();
  });

  it("deletes with the confirmation header boat requires", async () => {
    route("DELETE", "/sandboxes/bx_23456789", { ok: true, operation: { id: "bdop_x" } });
    await client().deleteResource("sandbox", "acct:sandbox:bx_23456789", "acct");
    expect(calls[0]!.headers["X-Ascii-Confirm-Delete"]).toBe("bx_23456789");
  });

  it("creates with an idempotency key, labels, env and hosted ports", async () => {
    route("POST", "/sandboxes", {
      ok: true,
      status: "provisioning",
      sandbox: { ...SANDBOX, state: "provisioning" },
    });
    const r = await client().createResource("sandbox", "acct", {
      name: "run",
      size: "large",
      from: "none",
      environment: "none",
      ttlSeconds: "none",
      visibility: "shared",
      labels: "team=ml, run=1",
      env: "A=1\n# c\nexport B='two'",
      hostedPorts: "3000, 8080",
    });
    expect(r.fields["state"]).toBe("provisioning");
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.body).toEqual({
      name: "run",
      type: "large",
      noEnv: true,
      ttlSeconds: null,
      visibility: "shared",
      labels: { team: "ml", run: "1" },
      env: { A: "1", B: "two" },
      hostedPorts: [{ port: 3000 }, { port: 8080 }],
    });
  });

  it("sends only changed fields, so a rename keeps the auto-stop clock", async () => {
    route("GET", "/sandboxes/bx_23456789", {
      ok: true,
      sandbox: { ...SANDBOX, ttlSeconds: 3600, subdomain: "frazil-pneuma-rallye" },
    });
    route("PATCH", "/sandboxes/bx_23456789", { ok: true, sandbox: SANDBOX });
    await client().updateResource("sandbox", "acct:sandbox:bx_23456789", "acct", {
      name: "renamed",
      ttlSeconds: "3600",
      subdomain: "frazil-pneuma-rallye",
    });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "renamed" });
  });

  it("clears auto-stop when the field is emptied on edit", async () => {
    route("GET", "/sandboxes/bx_23456789", { ok: true, sandbox: { ...SANDBOX, ttlSeconds: 3600 } });
    route("PATCH", "/sandboxes/bx_23456789", { ok: true, sandbox: SANDBOX });
    await client().updateResource("sandbox", "acct:sandbox:bx_23456789", "acct", {
      ttlSeconds: "",
    });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ ttlSeconds: null });
  });

  it("resolves the desktop URL on demand", async () => {
    route("GET", "/sandboxes/bx_23456789", { ok: true, sandbox: SANDBOX });
    await expect(
      client().resolveOutput("sandbox", "acct:sandbox:bx_23456789", "desktopUrl", "acct"),
    ).resolves.toBe("https://desktop/?t=secret");
  });

  it("stops, force-stops and authorizes SSH keys", async () => {
    route("POST", "/sandboxes/bx_23456789/stop", {
      ok: true,
      id: "bx_23456789",
      status: "archiving",
    });
    route("POST", "/sandboxes/bx_23456789/sshkey", {
      ok: true,
      sshUser: "user",
      machineIp: "203.0.113.10",
      sshEndpoint: null,
      hostKey: "ssh-ed25519 AAAA",
    });
    const c = client();
    await c.invokeAction("sandbox", "acct:sandbox:bx_23456789", "stop", "acct");
    await c.invokeAction("sandbox", "acct:sandbox:bx_23456789", "force-stop", "acct");
    expect(calls.map((x) => x.body)).toEqual([{ force: false }, { force: true }]);
    const out = await c.executeNoSqlCommand(
      "sandbox",
      "acct:sandbox:bx_23456789",
      "acct",
      "authorize-ssh-key",
      [JSON.stringify({ publicKey: "ssh-ed25519 AAAA me" })],
    );
    expect(calls[2]!.body).toEqual({ key: "ssh-ed25519 AAAA me" });
    expect(out).toMatchObject({ sshUser: "user", hostKey: "ssh-ed25519 AAAA" });
  });
});

describe("environments", () => {
  it("lists variable names and never values", async () => {
    route("GET", "/environments", {
      environments: [
        {
          id: "e1",
          name: "base",
          isDefault: true,
          latestVersionId: null,
          latestVersionNumber: 3,
          safeForThirdParties: false,
          passGithub: true,
          passSecrets: true,
          passSandboxCredentials: false,
          passAgentsCredentials: true,
          envContents: "TOKEN=hunter2\nexport URL=https://x",
          secretFiles: [{ path: "/home/user/.npmrc", contents: "secret" }],
          versions: [],
        },
      ],
    });
    const [env] = await client().listResources("environment", "acct");
    expect(env!.fields["envVarNames"]).toBe("TOKEN, URL");
    expect(env!.fields["secretFiles"]).toBe("/home/user/.npmrc");
    expect(JSON.stringify(env)).not.toContain("hunter2");
    expect(JSON.stringify(env)).not.toContain('"secret"');
  });
});

describe("costs", () => {
  it("reads each running day of each sandbox that ran in the range", async () => {
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    route("GET", "/sandboxes", {
      sandboxes: [
        { ...SANDBOX, createdAt: "2026-11-11T18:00:00Z" },
        // Stopped before the range: never read.
        { ...SANDBOX, id: "bx_3456789a", state: "archived", stoppedAt: "2026-11-01T00:00:00Z" },
      ],
      pageInfo: { hasMore: false, nextCursor: null, limit: 200 },
    });
    route("GET", "/sandboxes/bx_23456789/usage", (c: Call) => {
      const since = c.url.searchParams.get("since")!;
      const until = c.url.searchParams.get("until")!;
      const seconds = (Date.parse(until) - Date.parse(since)) / 1000;
      return { sandboxId: "bx_23456789", seconds, dollars: seconds / 100000 };
    });
    const rows = await client().fetchCostData("acct", {
      fromDate: "2026-11-10",
      toDate: "2026-11-13",
    });
    vi.useRealTimers();
    expect(calls.some((c) => c.url.pathname.includes("bx_3456789a"))).toBe(false);
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ["2026-11-11", 0.216],
      ["2026-11-12", 0.864],
      ["2026-11-13", 0.432],
    ]);
    expect(rows[0]).toMatchObject({
      resourceId: "bx_23456789",
      currency: "USD",
      tags: { team: "ml" },
    });
  });

  it("clips a sandbox's days to when it existed", () => {
    const day = Date.parse("2026-11-10T00:00:00Z");
    expect(
      activeWindow(
        { state: "archived", createdAt: null, stoppedAt: "2026-11-09T00:00:00Z" },
        day,
        day + 86400000,
      ),
    ).toBeNull();
    expect(
      activeWindow(
        { state: "running", createdAt: "2026-11-10T06:00:00Z", stoppedAt: null },
        day,
        day + 86400000,
      ),
    ).toEqual({ from: day + 6 * 3600000, to: day + 86400000 });
  });
});

describe("limits", () => {
  const LIMITS = {
    ok: true,
    type: "limits",
    activeSandboxes: 3,
    maxActiveSandboxes: 100,
    canStart: true,
    billingStatus: "active",
    starts: {
      unlimited: false,
      minute: { limit: 12, used: 1 },
      hour: { limit: 60, used: 5 },
      day: null,
    },
    wallet: { balanceDollars: 12.5 },
    planIncluded: { vmHours: 555, vmHoursRemaining: 500, periodEnd: null },
    overagePrices: { vmHourDollars: 0.036 },
    machineTypes: [{ type: "xlarge", available: false, reason: "needs the $100 plan" }],
  } as unknown as BLimits;

  it("reports every limit boat states, and none it does not", () => {
    const q = quotasFrom(LIMITS, { included: 10, used: 4 });
    expect(q.map((x) => [x.id, x.used, x.limit])).toEqual([
      ["sandboxes/active", 3, 100],
      ["starts/minute", 1, 12],
      ["starts/hour", 5, 60],
      ["plan/vm-hours", 55, 555],
      ["plan/saved-snapshots", 4, 10],
    ]);
  });

  it("reads the wallet as the credit balance", async () => {
    route("GET", "/limits", LIMITS);
    await expect(client().fetchCreditBalance("acct")).resolves.toEqual([
      { key: "wallet", label: "Wallet", remaining: 12.5, currency: "USD" },
    ]);
  });

  it("prices sizes from the account and marks the ones it cannot create", () => {
    const sizes = sizeOptions(LIMITS);
    expect(sizes.find((s) => s.id === "default")?.priceMonthly).toBe(26.28);
    expect(sizes.find((s) => s.id === "xlarge")?.label).toContain("needs the $100 plan");
  });
});

describe("status feed", () => {
  it("turns failing probes and warnings into incidents", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        checkedAt: "2026-11-13T00:36:02Z",
        components: [
          { name: "Ascii API", status: "operational", checkedAt: "2026-11-13T00:30:02Z" },
          {
            name: "Box Fork",
            status: "degraded",
            checkedAt: "2026-11-13T00:17:10Z",
            message: "slow",
          },
          { name: "Ascii API", status: "outage", checkedAt: "2026-11-13T00:30:02Z" },
          { name: "Box Dashboard", status: "outage" },
        ],
        announcements: [
          { title: "Maintenance", severity: "info", createdAt: "2026-11-12T00:00:00Z" },
          { title: "Resume delays", severity: "warning", createdAt: "2026-11-12T00:00:00Z" },
        ],
      }),
    );
    expect(incidents.map((i) => [i.externalId, i.impact, i.providerWide])).toEqual([
      ["component:Box Fork", "minor", false],
      ["component:Ascii API", "major", true],
      ["announcement:2026-11-12T00:00:00Z:Resume delays", "minor", true],
    ]);
    expect(incidents[0]!.resourceTypes).toEqual(["sandbox"]);
  });
});

describe("parsers", () => {
  it("validates labels, env, ports, events and auto-stop", () => {
    expect(parseLabels("a=1,\nb")).toEqual({ a: "1", b: "" });
    expect(() => parseLabels("-bad=1")).toThrow();
    expect(parseEnv('X="q"')).toEqual({ X: "q" });
    expect(() => parseEnv("1X=2")).toThrow();
    expect(envVarNames("# c\nA=1\nA=2\nB")).toEqual(["A", "B"]);
    expect(parsePorts("80 443,80")).toEqual([80, 443]);
    expect(() => parsePorts("70000")).toThrow();
    expect(parseEvents("sandbox.ready, sandbox.error")).toEqual(["sandbox.ready", "sandbox.error"]);
    expect(() => parseEvents("sandbox.nope")).toThrow();
    expect(ttlOf("none")).toBeNull();
    expect(ttlOf("")).toBeUndefined();
    expect(() => ttlOf("2592001")).toThrow();
    expect(sshCommand("2001:db8::1", "")).toBe("ssh user@[2001:db8::1]");
  });
});
