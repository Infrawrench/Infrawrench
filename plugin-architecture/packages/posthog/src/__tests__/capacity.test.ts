import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { PostHogClient } from "../client.js";
import { plugin } from "../plugin.js";
import { CREDS, makeHttp } from "./helpers.js";

function orgType() {
  const t = plugin.resourceTypes.find((r) => r.id === "organization");
  if (!t) throw new Error("organization");
  return t;
}

function listOrg(billing: unknown) {
  const { http } = makeHttp((url) => {
    if (url.pathname === "/api/organizations/org-1/")
      return { body: { id: "org-1", name: "Acme", member_count: 3, projects: [] } };
    if (url.pathname === "/api/billing/") return { body: billing };
    return undefined;
  });
  const c = hostClient(new PostHogClient(CREDS, { http }));
  return c.listResources("organization", "acct");
}

const BILLING = {
  billing_period: {
    current_period_start: "2026-11-05T00:00:00Z",
    current_period_end: "2026-12-05T00:00:00Z",
    interval: "month",
  },
  products: [
    { type: "product_analytics", current_usage: 640_000, usage_limit: 1_000_000 },
    { type: "session_replay", current_usage: 1200, usage_limit: 5000 },
    { type: "feature_flags", current_usage: 30_000, usage_limit: null },
  ],
};

describe("billing usage on the organization", () => {
  it("stores each product's usage against the limit where ingestion stops", async () => {
    const [org] = await listOrg(BILLING);
    expect(org!.fields).toMatchObject({
      periodStart: "2026-11-05T00:00:00Z",
      periodEnd: "2026-12-05T00:00:00Z",
      eventsUsed: 640_000,
      eventsLimit: 1_000_000,
      recordingsUsed: 1200,
      recordingsLimit: 5000,
      flagRequestsUsed: 30_000,
    });
    expect(org!.fields).not.toHaveProperty("flagRequestsLimit");
    expect(org!.fields).not.toHaveProperty("exceptionsUsed");
    const events = capacityDeclarations(orgType()).find((d) => d.key === "eventsUsed")!;
    expect(events.declaration.cycle).toEqual({
      period: "monthly",
      startField: "periodStart",
      endField: "periodEnd",
    });
    expect(resolveCapacityLimit(events.declaration.limit, org!.fields)?.limit).toBe(1_000_000);
  });

  it("leaves product usage out on an annual plan", async () => {
    const [org] = await listOrg({
      ...BILLING,
      billing_period: { ...BILLING.billing_period, interval: "year" },
    });
    expect(org!.fields).not.toHaveProperty("eventsUsed");
    expect(org!.fields).not.toHaveProperty("eventsLimit");
  });
});
