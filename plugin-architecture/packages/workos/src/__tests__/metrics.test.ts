import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkosClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct-1";
const ORG = "org_01ACME";
const RESOURCE = `${ACCOUNT}:organization:${ORG}`;

function respond(pages: unknown[]) {
  const urls: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string) => {
    const url = new URL(String(input));
    urls.push(url);
    const text = JSON.stringify(pages[urls.length - 1] ?? { data: [], list_metadata: {} });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch);
  return { urls, client: new WorkosClient({ apiKey: "sk_test_key" }) };
}

const event = (name: string, at: string) => ({ object: "event", event: name, created_at: at });

afterEach(() => vi.restoreAllMocks());

describe("organization metrics", () => {
  it("declares the Metrics tab on organizations only", () => {
    const withMetrics = plugin.resourceTypes.filter((t) => t.supportsMetrics).map((t) => t.id);
    expect(withMetrics).toEqual(["organization"]);
    const { client } = respond([]);
    const view = client.renderDetail({
      id: RESOURCE,
      resourceTypeId: "organization",
      accountId: ACCOUNT,
      displayName: "Acme",
      fields: { name: "Acme" },
      resolvedOutputs: {},
    } as never);
    expect(view.metricsCapability).toEqual({ defaultTimeRangeMs: 86_400_000 });
  });

  it("counts SSO, session and Directory Sync events per bucket", async () => {
    const { urls, client } = respond([
      {
        data: [
          event("authentication.sso_succeeded", "2026-09-01T00:50:00Z"),
          event("authentication.sso_timed_out", "2026-09-01T00:40:00Z"),
          event("session.created", "2026-09-01T00:31:00Z"),
          event("authentication.sso_succeeded", "2026-09-01T00:10:00Z"),
          event("dsync.user.updated", "2026-09-01T00:05:00Z"),
        ],
        list_metadata: { after: null },
      },
    ]);
    const startMs = Date.parse("2026-09-01T00:00:00Z");
    const series = await client.fetchMetricSeries("organization", RESOURCE, ACCOUNT, {
      startMs,
      endMs: startMs + 60 * 60_000,
    });
    const query = urls[0]!.searchParams;
    expect(urls[0]!.pathname).toBe("/events");
    expect(query.get("organization_id")).toBe(ORG);
    expect(query.get("range_start")).toBe("2026-09-01T00:00:00.000Z");
    expect(query.get("order")).toBe("desc");
    expect(query.getAll("events")).toEqual(
      expect.arrayContaining(["authentication.sso_failed", "dsync.group.user_added"]),
    );
    expect(query.getAll("events")).not.toContain("dsync.activated");

    const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
    expect(Object.keys(byLabel)).toEqual([
      "SSO sign-ins",
      "SSO failures",
      "Sessions created",
      "Directory Sync changes",
    ]);
    // An hour in 48 buckets rounds up to 2-minute buckets.
    expect(byLabel["SSO sign-ins"]!.points).toHaveLength(30);
    const total = (label: string) =>
      byLabel[label]!.points.reduce((sum, point) => sum + point.value, 0);
    expect(total("SSO sign-ins")).toBe(2);
    expect(total("SSO failures")).toBe(1);
    expect(total("Sessions created")).toBe(1);
    expect(total("Directory Sync changes")).toBe(1);
    expect(byLabel["SSO sign-ins"]!.points[5]).toEqual({
      timestamp: startMs + 10 * 60_000,
      value: 1,
    });
  });

  it("starts the chart at the oldest fetched event when the page cap truncates", async () => {
    const page = (at: string) => ({
      data: [event("session.created", at)],
      list_metadata: { after: "event_next" },
    });
    const pages = Array.from({ length: 20 }, () => page("2026-09-01T00:30:00Z"));
    const { urls, client } = respond(pages);
    const startMs = Date.parse("2026-09-01T00:00:00Z");
    const [series] = await client.fetchMetricSeries("organization", RESOURCE, ACCOUNT, {
      startMs,
      endMs: startMs + 60 * 60_000,
    });
    expect(urls).toHaveLength(20);
    expect(urls[1]!.searchParams.get("after")).toBe("event_next");
    expect(series!.points[0]!.timestamp).toBeGreaterThanOrEqual(startMs + 30 * 60_000);
  });

  it("clamps a window longer than the Events API's 30 days", async () => {
    const { urls, client } = respond([]);
    const endMs = Date.parse("2026-09-30T00:00:00Z");
    await client.fetchMetricSeries("organization", RESOURCE, ACCOUNT, {
      startMs: endMs - 60 * 86_400_000,
      endMs,
    });
    expect(urls[0]!.searchParams.get("range_start")).toBe("2026-08-31T00:00:00.000Z");
  });
});
