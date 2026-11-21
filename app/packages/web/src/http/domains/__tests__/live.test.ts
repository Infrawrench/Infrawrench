import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The account and resource lookups reach Postgres; these tests are about the
// gate, the params, the backend choice and the headers.
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));
vi.mock("@/db/client", () => ({ db: {} }));
const mockAuthorize = vi.fn();
vi.mock("@infrawrench/server-core/live/topics", async (importOriginal) => {
  const real = await importOriginal<typeof import("@infrawrench/server-core/live/topics")>();
  const wrap = (
    definition: (typeof real.LIVE_TOPIC_DEFINITIONS)[keyof typeof real.LIVE_TOPIC_DEFINITIONS],
  ) =>
    definition.authorize
      ? { ...definition, authorize: (...a: unknown[]) => mockAuthorize(...a) }
      : definition;
  const definitions = Object.fromEntries(
    Object.entries(real.LIVE_TOPIC_DEFINITIONS).map(([k, v]) => [k, wrap(v)]),
  );
  return {
    ...real,
    LIVE_TOPIC_DEFINITIONS: definitions,
    liveTopicDefinition: (topic: string) =>
      Object.prototype.hasOwnProperty.call(definitions, topic) ? definitions[topic] : undefined,
  };
});
const { liveDomain } = await import("@/http/domains/live/index");
const app = (permissions?: string[]) =>
  buildTestApi(liveDomain, {
    basePath: "/api/org/org-1/live",
    ...(permissions ? { permissions } : {}),
  });

const ticket = (body: unknown, permissions?: string[]) =>
  app(permissions).request("/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// A secret in the SDK's format, made per run so no literal looks like a real one.
const NEON_ENV = {
  NEON_REALTIME_URL: "wss://realtime.example.test",
  NEON_REALTIME_SECRET: `nrt_live_1${randomBytes(32).toString("base64url")}`,
  DATABASE_URL: "postgres://u:p@db.example.test/core",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [...Object.keys(NEON_ENV), "LIVE_UPDATES", "NEON_REALTIME_DB"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  mockAuthorize.mockResolvedValue(true);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const useNeon = () => Object.assign(process.env, NEON_ENV);

describe("live ticket route", () => {
  it("answers poll when Neon is not configured, uncacheable", async () => {
    const res = await ticket({ topic: "ci-runs" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ driver: "poll" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("seals the topic's org-scoped signal when Neon is configured", async () => {
    useNeon();
    const res = await ticket({ topic: "jit-requests" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      driver: string;
      url: string;
      query: { capability: string; queryFingerprint: string; expiresAt: number };
    };
    expect(body.driver).toBe("neon");
    expect(body.url).toBe("wss://realtime.example.test");
    expect(typeof body.query.capability).toBe("string");
    // Sealed: neither the org nor the SQL is readable in the capability.
    expect(body.query.capability).not.toContain("org-1");
    expect(body.query.capability).not.toContain("jit_access_requests");
    expect(body.query.expiresAt).toBeGreaterThan(Date.now());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses without the topic's permission", async () => {
    useNeon();
    const res = await ticket({ topic: "change-freezes" }, ["access:read"]);
    expect(res.status).toBe(403);
  });

  it("refuses an unknown topic", async () => {
    const res = await ticket({ topic: "everything" });
    expect(res.status).toBe(400);
  });

  it("refuses an account topic without the account", async () => {
    useNeon();
    const res = await ticket({ topic: "account-resources" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "account-resources needs accountId" });
  });

  it("answers 404 for an account outside the org, before sealing", async () => {
    useNeon();
    mockAuthorize.mockResolvedValue(false);
    const res = await ticket({ topic: "account-resources", accountId: "acc-other" });
    expect(res.status).toBe(404);
    expect(mockAuthorize).toHaveBeenCalledWith("org-1", { accountId: "acc-other" });
  });

  it("gives each account its own query", async () => {
    useNeon();
    const fingerprint = async (accountId: string) => {
      const res = await ticket({ topic: "account-resources", accountId });
      expect(res.status).toBe(200);
      return ((await res.json()) as { query: { queryFingerprint: string } }).query.queryFingerprint;
    };
    expect(await fingerprint("acc-1")).toBe(await fingerprint("acc-1"));
    expect(await fingerprint("acc-1")).not.toBe(await fingerprint("acc-2"));
  });

  it("polls when LIVE_UPDATES=poll overrides the Neon settings", async () => {
    useNeon();
    process.env["LIVE_UPDATES"] = "poll";
    const res = await ticket({ topic: "ci-runs" });
    expect(await res.json()).toEqual({ driver: "poll" });
  });
});
