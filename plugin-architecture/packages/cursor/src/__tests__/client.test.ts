import { describe, expect, it } from "vitest";
import { evaluateOrphanRule } from "@infrawrench/plugin-base";
import { CursorClient, parseDollarLimit, validateRepoUrl } from "../client.js";
import { TeamMemberResourceType } from "../resource-types.js";
import type { Reply } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const today = new Date().toISOString().slice(0, 10);

const MEMBERS = [
  { id: "user_1", name: "Dev", email: "dev@acme.com", role: "member", isRemoved: false },
  { id: "user_2", name: "Idle", email: "idle@acme.com", role: "member", isRemoved: false },
  { id: "user_3", name: "IT", email: "it@acme.com", role: "free-owner", isRemoved: false },
  { id: "user_4", name: "Gone", email: "gone@acme.com", role: "member", isRemoved: true },
];

type Route = (url: URL, method: string, body: unknown) => Reply | undefined;

function client(extra: Route = () => undefined, credentials: Record<string, string> = {}) {
  const { http, calls } = makeHttp((url, method, body) => {
    const custom = extra(url, method, body);
    if (custom) return custom;
    switch (url.pathname) {
      case "/teams/members":
        return { body: { teamMembers: MEMBERS } };
      case "/teams/spend":
        return {
          body: {
            teamMemberSpend: [
              {
                userId: "user_1",
                email: "dev@acme.com",
                spendCents: 2450,
                fastPremiumRequests: 12,
                hardLimitOverrideDollars: 100,
                monthlyLimitDollars: 200,
                effectivePerUserLimitDollars: 100,
              },
            ],
            subscriptionCycleStart: Date.parse("2026-10-01T00:00:00Z"),
            totalPages: 1,
          },
        };
      case "/teams/daily-usage-data":
        return {
          body: {
            data: [
              {
                email: "dev@acme.com",
                day: today,
                isActive: true,
                agentRequests: 3,
                chatRequests: 2,
                acceptedLinesAdded: 40,
                totalTabsShown: 10,
                totalTabsAccepted: 5,
                mostUsedModel: "gpt-5",
                clientVersion: "1.7.0",
              },
            ],
            pagination: { hasNextPage: false },
          },
        };
      case "/teams/filtered-usage-events":
        return {
          body: {
            usageEvents: [
              {
                timestamp: String(Date.now() - 1000),
                userEmail: "dev@acme.com",
                model: "gpt-5",
                kind: "Usage-based",
                maxMode: true,
                chargedCents: 25,
                tokenUsage: { inputTokens: 100, outputTokens: 50, totalCents: 24 },
              },
              {
                timestamp: String(Date.now() - 2000),
                userEmail: "idle@acme.com",
                model: "gpt-5",
                kind: "Included in Business",
                tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 2 },
              },
            ],
            pagination: { hasNextPage: false },
          },
        };
      default:
        if (url.pathname.startsWith("/analytics/")) return { status: 403, body: {} };
        return { status: 404, body: { error: "not found" } };
    }
  });
  const c = new CursorClient({ apiKey: "crsr_test", ...credentials }, { http } as never);
  c.setRetryDelayMs(0);
  return { c, calls };
}

describe("team members", () => {
  it("joins members, spend and activity, and flags idle paid seats", async () => {
    const { c } = client();
    const rows = await c.listResources("team-member", "acc");
    const byEmail = Object.fromEntries(rows.map((r) => [r.fields["email"], r]));
    expect(byEmail["dev@acme.com"]!.fields).toMatchObject({
      seat: "standard",
      seatStatus: "active",
      lastActiveAt: today,
      requests30d: 5,
      acceptedLines30d: 40,
      spendThisCycleUsd: 24.5,
      spendLimitDollars: 100,
      teamLimitDollars: 200,
      mostUsedModel: "gpt-5",
    });
    expect(byEmail["idle@acme.com"]!.fields["seatStatus"]).toBe("idle");
    expect(byEmail["it@acme.com"]!.fields).toMatchObject({ seat: "none", seatStatus: "unpaid" });
    expect(byEmail["gone@acme.com"]!.fields["seatStatus"]).toBe("removed");

    const flagged = rows
      .filter((r) => evaluateOrphanRule(TeamMemberResourceType.orphanRule!, r.fields))
      .map((r) => r.fields["email"]);
    expect(flagged).toEqual(["idle@acme.com"]);
    expect(rows[0]!.id).toBe("acc:team-member:user_1");
  });

  it("validates and writes a spend limit by email", async () => {
    const writes: unknown[] = [];
    const { c } = client((url, _m, body) => {
      if (url.pathname === "/teams/user-spend-limit") {
        writes.push(body);
        return { body: { outcome: "success", message: "ok" } };
      }
      return undefined;
    });
    await expect(
      c.updateResource("team-member", "acc:team-member:user_1", "acc", {
        spendLimitDollars: "12.5",
      }),
    ).rejects.toThrow(/whole number/);
    await c.updateResource("team-member", "acc:team-member:user_1", "acc", {
      spendLimitDollars: "150",
    });
    await c.updateResource("team-member", "acc:team-member:user_1", "acc", {
      spendLimitDollars: "",
    });
    expect(writes).toEqual([
      { userEmail: "dev@acme.com", spendLimitDollars: 150 },
      { userEmail: "dev@acme.com", spendLimitDollars: null },
    ]);
  });

  it("surfaces Cursor's error outcome", async () => {
    const { c } = client((url) =>
      url.pathname === "/teams/user-spend-limit"
        ? { body: { outcome: "error", message: "Invalid email format" } }
        : undefined,
    );
    await expect(
      c.updateResource("team-member", "acc:team-member:user_1", "acc", { spendLimitDollars: "5" }),
    ).rejects.toThrow(/Invalid email format/);
  });

  it("removes a member by encoded id", async () => {
    const { c, calls } = client((url) =>
      url.pathname === "/teams/remove-member" ? { body: { success: true } } : undefined,
    );
    await c.deleteResource("team-member", "acc:team-member:user_2");
    expect(calls.at(-1)!.body).toEqual({ userId: "user_2" });
  });
});

describe("team and models", () => {
  it("summarises seats, spend and estimated seat cost", async () => {
    const { c } = client(undefined, { seatPriceMonthly: "32" });
    const [team] = await c.listResources("team", "acc");
    expect(team!.fields).toMatchObject({
      members: 3,
      paidSeats: 2,
      idleSeats: 1,
      unpaidAdmins: 1,
      cycleStart: "2026-10-01",
      cycleSpendUsd: 24.5,
      estimatedSeatCostUsd: 64,
      activeUsers30d: 1,
      analyticsApi: false,
    });
  });

  it("lists models from usage events", async () => {
    const { c } = client();
    const models = await c.listResources("model", "acc");
    expect(models).toHaveLength(1);
    expect(models[0]!.fields).toMatchObject({
      requests30d: 2,
      usageBasedRequests30d: 1,
      includedRequests30d: 1,
      usageBasedSpendUsd30d: 0.25,
      inputTokens30d: 110,
      maxModeRequests30d: 1,
      users30d: 2,
    });
  });

  it("serves model metrics from events and skips the Enterprise-only series", async () => {
    const { c } = client();
    const series = await c.fetchMetricSeries("model", "acc:model:gpt-5", "acc");
    const spend = series.find((s) => s.label === "Usage-based spend");
    expect(spend!.points.map((p) => p.value)).toEqual([0.25]);
    expect(series.some((s) => s.label.startsWith("Messages"))).toBe(false);
  });

  it("declares a metrics capability on every type that has metrics", () => {
    const { c } = client();
    const detail = c.renderDetail({
      id: "acc:team:team",
      pluginId: "cursor",
      resourceTypeId: "team",
      accountId: "acc",
      displayName: "Cursor team",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(detail.metricsCapability).toBeDefined();
    expect(detail.logs).toBeDefined();
  });
});

describe("groups", () => {
  it("sets directory group membership to exactly the listed emails", async () => {
    const changes: Array<[string, unknown]> = [];
    const { c } = client((url, method, body) => {
      if (url.pathname === "/teams/directory-groups/g1/members" && method === "GET") {
        return {
          body: {
            members: [{ userId: "user_2", email: "idle@acme.com" }],
            pagination: { hasNextPage: false },
          },
        };
      }
      if (url.pathname.endsWith("/bulk-add") || url.pathname.endsWith("/bulk-remove")) {
        changes.push([url.pathname.split("/").pop()!, body]);
        return { body: {} };
      }
      if (url.pathname === "/teams/directory-groups/g1") {
        if (method === "PATCH") changes.push(["patch", body]);
        return { body: { group: { id: "g1", name: "Eng", memberCount: 1 } } };
      }
      return undefined;
    });
    await c.updateResource("directory-group", "acc:directory-group:g1", "acc", {
      members: "dev@acme.com",
      monthlySpendingLimitDollars: "",
    });
    expect(changes).toEqual([
      ["bulk-add", { userIds: ["user_1"] }],
      ["bulk-remove", { userIds: ["user_2"] }],
      ["patch", { clearMonthlySpendingLimitDollars: true }],
    ]);
  });

  it("rejects emails that are not team members", async () => {
    const { c } = client((url, method) =>
      url.pathname === "/teams/directory-groups/g1/members" && method === "GET"
        ? { body: { members: [], pagination: { hasNextPage: false } } }
        : undefined,
    );
    await expect(
      c.updateResource("directory-group", "acc:directory-group:g1", "acc", {
        members: "stranger@else.com",
      }),
    ).rejects.toThrow(/stranger@else.com/);
  });

  it("offers team members in the create picker", async () => {
    const { c } = client();
    const config = await c.getCreateConfig("billing-group");
    const picker = config.fields.find((f) => f.key === "memberIds")!;
    expect(picker.policies!.map((p) => p.id).sort()).toEqual(["user_1", "user_2", "user_3"]);
  });
});

describe("validation helpers", () => {
  it("parses dollar limits", () => {
    expect(parseDollarLimit("", "x")).toBeNull();
    expect(parseDollarLimit("$25", "x")).toBe(25);
    expect(() => parseDollarLimit("-1", "x")).toThrow();
    expect(() => parseDollarLimit("3000000000", "x")).toThrow();
  });

  it("requires an http(s) repository URL", () => {
    expect(validateRepoUrl("https://github.com/acme/app/")).toBe("https://github.com/acme/app");
    expect(() => validateRepoUrl("acme/app")).toThrow();
    expect(() => validateRepoUrl("ftp://x.com/a")).toThrow();
  });
});

describe("transport", () => {
  it("retries a 429 before giving up", async () => {
    let hits = 0;
    const { c } = client((url) => {
      if (url.pathname !== "/settings/repo-blocklists/repos") return undefined;
      hits += 1;
      return hits < 3
        ? { status: 429, body: {} }
        : { body: { repos: [{ id: "r1", url: "https://github.com/a/b", patterns: ["*.env"] }] } };
    });
    const rows = await c.listResources("repo-blocklist", "acc");
    expect(hits).toBe(3);
    expect(rows[0]!.fields).toMatchObject({ patterns: "*.env", patternCount: 1 });
  });
});

describe("preflight", () => {
  it("never writes, and reports a non-Enterprise team", async () => {
    const { c, calls } = client();
    const result = await c.verifyCredentials();
    expect(result.checks.map((ch) => [ch.capabilityId, ch.status])).toEqual([
      ["read", "ok"],
      ["write", "unknown"],
      ["analytics", "missing"],
    ]);
    expect(
      calls.every(
        (call) => call.method === "GET" || call.url.pathname !== "/teams/user-spend-limits",
      ),
    ).toBe(true);
    expect(result.identity).toBe("Cursor team (3 members)");
  });
});

describe("audit log", () => {
  it("renders the newest events last", async () => {
    const { c } = client((url) =>
      url.pathname === "/teams/audit-logs"
        ? {
            body: {
              events: [
                {
                  timestamp: "2026-10-02T00:00:00Z",
                  event_type: "add_user",
                  user_email: "a@acme.com",
                },
                {
                  timestamp: "2026-10-01T00:00:00Z",
                  event_type: "login",
                  user_email: "b@acme.com",
                  ip_address: "1.2.3.4",
                },
              ],
              pagination: { hasNextPage: false },
            },
          }
        : undefined,
    );
    const logs = await c.getLogs("team", "acc:team:team", "acc", { tailLines: 50 });
    expect(logs.text).toBe(
      "2026-10-01T00:00:00Z login b@acme.com from 1.2.3.4\n2026-10-02T00:00:00Z add_user a@acme.com\n",
    );
  });
});
