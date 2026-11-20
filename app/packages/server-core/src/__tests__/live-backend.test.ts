import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LIVE_TOPICS } from "@infrawrench/client-core";
import {
  databaseNameFromUrl,
  liveBackendFromEnv,
  neonBackend,
  neonRealtimeConfig,
} from "../live/backend";
import { LIVE_TOPIC_DEFINITIONS, liveTopicDefinition } from "../live/topics";

/** A secret in the SDK's format, made per run so no literal looks like a real one. */
const testSecret = () => `nrt_live_1${randomBytes(32).toString("base64url")}`;

const NEON_ENV = {
  NEON_REALTIME_URL: "wss://realtime.example.test",
  NEON_REALTIME_SECRET: "configured",
  DATABASE_URL: "postgres://user:pw@db.example.test/core?sslmode=require",
};

describe("live backend selection", () => {
  it("polls when Neon is not configured", () => {
    expect(liveBackendFromEnv({}).kind).toBe("poll");
    expect(liveBackendFromEnv({ NEON_REALTIME_URL: "wss://x" }).kind).toBe("poll");
  });

  it("uses Neon when the URL and secret are set", () => {
    expect(liveBackendFromEnv(NEON_ENV).kind).toBe("neon");
    expect(neonRealtimeConfig(NEON_ENV)).toEqual({
      url: "wss://realtime.example.test",
      secret: "configured",
      db: "core",
    });
  });

  it("lets NEON_REALTIME_DB name the database", () => {
    expect(neonRealtimeConfig({ ...NEON_ENV, NEON_REALTIME_DB: "other" })?.db).toBe("other");
  });

  it("polls when LIVE_UPDATES=poll, whatever else is set", () => {
    expect(liveBackendFromEnv({ ...NEON_ENV, LIVE_UPDATES: "poll" }).kind).toBe("poll");
  });

  it.each([
    ["postgres://u:p@h/core?sslmode=require", "core"],
    ["postgresql://u:p@h:5432/my%20db", "my db"],
    ["postgres://u:p@h", undefined],
    ["not a url", undefined],
    [undefined, undefined],
  ])("reads the database name of %s", (url, name) => {
    expect(databaseNameFromUrl(url)).toBe(name);
  });
});

describe("neonBackend", () => {
  it("hands the client the URL and the sealed query", async () => {
    const seal = vi.fn(async () => ({ capability: "c", queryFingerprint: "f", expiresAt: 9 }));
    const backend = neonBackend({ url: "wss://r", secret: "s", db: "core" }, async () => seal);
    const signal = { sql: "SELECT 1 FROM t WHERE organization_id = $1", params: ["org"] };
    await expect(backend.ticket(signal)).resolves.toEqual({
      driver: "neon",
      url: "wss://r",
      query: { capability: "c", queryFingerprint: "f", expiresAt: 9 },
    });
    expect(seal).toHaveBeenCalledWith(signal);
  });

  it("retries loading the sealer after a failure", async () => {
    let attempts = 0;
    const backend = neonBackend({ url: "wss://r", secret: "s", db: "core" }, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("load failed");
      return async () => ({ capability: "c", queryFingerprint: "f", expiresAt: 1 });
    });
    const signal = { sql: "SELECT 1", params: [] };
    await expect(backend.ticket(signal)).rejects.toThrow("load failed");
    await expect(backend.ticket(signal)).resolves.toMatchObject({ driver: "neon" });
  });

  it("seals every topic's signal with the real SDK, the same query to the same fingerprint", async () => {
    const backend = neonBackend({ url: "wss://r", secret: testSecret(), db: "core" });
    for (const topic of LIVE_TOPICS) {
      const definition = LIVE_TOPIC_DEFINITIONS[topic];
      const signal = definition.signal("org-1", {
        accountId: "acc-1",
        resourceId: "res-1",
        workflowId: "wf-1",
      });
      const first = await backend.ticket(signal);
      const second = await backend.ticket(signal);
      expect(first.driver).toBe("neon");
      if (first.driver !== "neon" || second.driver !== "neon") continue;
      expect(first.query.capability).not.toContain("org-1");
      expect(first.query.queryFingerprint).toBe(second.query.queryFingerprint);
      expect(first.query.expiresAt).toBeGreaterThan(Date.now());
    }
  });
});

describe("live topics", () => {
  it("has a definition for every topic and nothing else", () => {
    expect(Object.keys(LIVE_TOPIC_DEFINITIONS).sort()).toEqual([...LIVE_TOPICS].sort());
    expect(liveTopicDefinition("toString")).toBeUndefined();
    expect(liveTopicDefinition("nope")).toBeUndefined();
  });

  it.each(LIVE_TOPICS)("%s binds the org as $1 and selects without side effects", (topic) => {
    const signal = LIVE_TOPIC_DEFINITIONS[topic].signal("org-1", {
      accountId: "acc-1",
      resourceId: "res-1",
    });
    expect(signal.params[0]).toBe("org-1");
    expect(signal.sql).toMatch(/^SELECT /);
    expect(signal.sql).toContain("organization_id = $1");
    expect(signal.sql).not.toContain(";");
    // Volatile functions are refused by Realtime; ids are always bound, never inlined.
    expect(signal.sql).not.toMatch(/now\(\)|random\(|gen_random_uuid|current_timestamp/i);
    for (const value of ["org-1", "acc-1", "res-1"]) expect(signal.sql).not.toContain(value);
  });

  it("scopes approvals to one workflow when asked", () => {
    const signal = LIVE_TOPIC_DEFINITIONS["workflow-approvals"].signal("org-1", {
      workflowId: "wf-1",
    });
    expect(signal.params).toEqual(["org-1", "wf-1"]);
    expect(signal.sql).toContain("workflow_id = $2");
  });

  it("requires and authorizes the ids account and resource topics name", () => {
    expect(LIVE_TOPIC_DEFINITIONS["account-resources"].requires).toEqual(["accountId"]);
    expect(LIVE_TOPIC_DEFINITIONS["account-resources"].authorize).toBeDefined();
    expect(LIVE_TOPIC_DEFINITIONS.resource.requires).toEqual(["resourceId"]);
    expect(LIVE_TOPIC_DEFINITIONS.resource.authorize).toBeDefined();
  });
});
