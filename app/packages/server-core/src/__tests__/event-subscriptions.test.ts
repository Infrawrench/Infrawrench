import { createHmac, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COST_ANOMALY_DETECTED,
  DRIFT_DETECTED,
  EVENT_SIGNATURE_TOLERANCE_SECONDS,
  formatEventSignatureHeader,
  parseEventSignatureHeader,
} from "@infrawrench/client-core";

// A chainable stand-in for the two queries `publishEvent` makes.
const state = vi.hoisted(() => ({
  subs: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
}));
vi.mock("../db/client", () => {
  const select = () => ({
    from: () => ({ where: async () => state.subs }),
  });
  const insert = () => ({
    values: (rows: Array<Record<string, unknown>>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          state.inserted.push(...rows);
          return rows.map((r) => ({ id: r["id"] }));
        },
      }),
    }),
  });
  return { db: { select, insert } };
});

const { publishEvent, environmentFromFields } = await import("../events/publish");
const { signEventBody } = await import("../events/deliver");

/** What the docs tell a receiver to do, written independently of the signer. */
function verify(secret: string, header: string, body: string, nowSeconds: number): boolean {
  const parsed = parseEventSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > EVENT_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${body}`).digest();
  return parsed.signatures.some((s) => timingSafeEqual(Buffer.from(s, "hex"), expected));
}

describe("webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "drift.detected", data: {} });
  it("verifies with the current secret and with the previous one during rollover", () => {
    const header = formatEventSignatureHeader(
      1_700_000_000,
      signEventBody(["new", "old"], 1_700_000_000, body),
    );
    expect(verify("new", header, body, 1_700_000_010)).toBe(true);
    expect(verify("old", header, body, 1_700_000_010)).toBe(true);
    expect(verify("other", header, body, 1_700_000_010)).toBe(false);
  });
  it("fails on a modified body or a stale timestamp", () => {
    const header = formatEventSignatureHeader(
      1_700_000_000,
      signEventBody(["s"], 1_700_000_000, body),
    );
    expect(verify("s", header, body + " ", 1_700_000_000)).toBe(false);
    expect(verify("s", header, body, 1_700_000_000 + 3600)).toBe(false);
  });
});

describe("environmentFromFields", () => {
  it("reads env-like keys from tags or labels, case-insensitively", () => {
    expect(environmentFromFields({ tags: { Environment: " prod " } })).toBe("prod");
    expect(environmentFromFields({ labels: { env: "staging" } })).toBe("staging");
    expect(environmentFromFields({ tags: { team: "core" } })).toBeNull();
    expect(environmentFromFields({ tags: ["env"] })).toBeNull();
    expect(environmentFromFields(null)).toBeNull();
  });
});

describe("publishEvent", () => {
  beforeEach(() => {
    state.subs = [];
    state.inserted = [];
  });
  const sub = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    eventTypes: [],
    minSeverity: null,
    accountIds: [],
    environments: [],
    ...extra,
  });
  const drift = {
    since: "2026-10-12T00:00:00.000Z",
    changeCount: 3,
    created: 1,
    updated: 1,
    deleted: 1,
    accountIds: ["acc_1"],
  };

  it("queues one row per matching subscription with a shared envelope", async () => {
    state.subs = [
      sub("all"),
      sub("drift-only", { eventTypes: ["drift.detected"] }),
      sub("costs-only", { eventTypes: ["cost.anomaly.detected"] }),
      sub("other-account", { accountIds: ["acc_2"] }),
      sub("critical-only", { minSeverity: "critical" }),
    ];
    const n = await publishEvent(DRIFT_DETECTED, "org_1", drift, {
      title: "3 changes",
      accountId: "acc_1",
      idempotencyKey: "drift:x",
    });
    expect(n).toBe(2);
    expect(state.inserted.map((r) => r["subscriptionId"])).toEqual(["all", "drift-only"]);
    const [a, b] = state.inserted;
    expect(a?.["eventId"]).toBe(b?.["eventId"]);
    expect(a?.["idempotencyKey"]).toBe("drift:x");
    expect(a?.["payload"]).toMatchObject({
      type: "drift.detected",
      version: 1,
      organizationId: "org_1",
      severity: "info",
      accountId: "acc_1",
      environment: null,
      test: false,
      data: drift,
    });
  });

  it("never emits a cost event about a private cost object", async () => {
    state.subs = [sub("all")];
    const n = await publishEvent(
      COST_ANOMALY_DETECTED,
      "org_1",
      {
        anomalyId: "a",
        day: "2026-10-11",
        kind: "spike",
        dimension: "provider",
        dimensionKey: "aws",
        actual: 10,
        baseline: 1,
        currency: "USD",
        hints: [],
      },
      { title: "x", privateCostObject: true },
    );
    expect(n).toBe(0);
    expect(state.inserted).toEqual([]);
  });
});
