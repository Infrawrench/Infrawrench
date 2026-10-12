import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemediationSeat } from "@infrawrench/plugin-base";
import { AnthropicClient } from "../client.js";
import { plugin } from "../plugin.js";
import { anthropicSeatRemediationCommands } from "../remediation.js";
import { analyticsWindow, organizationKind } from "../seats.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");

interface Call {
  url: string;
  method: string;
  key: string | undefined;
}
let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function install(handler: (url: URL, method: string) => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method, key: headers?.["x-api-key"] });
    return handler(new URL(String(url)), method);
  }) as typeof fetch);
}

const ENTERPRISE_USERS = [
  {
    id: "user_owner",
    email: "Boss@Acme.com",
    name: "Boss",
    role: "primary_owner",
    added_at: "2026-01-05T00:00:00Z",
  },
  {
    id: "user_dev",
    email: "dev@acme.com",
    name: "Dev",
    role: "user",
    added_at: "2026-02-01T00:00:00Z",
  },
  {
    id: "user_idle",
    email: "idle@acme.com",
    name: "Idle",
    role: "managed",
    added_at: "2026-03-01T00:00:00Z",
  },
];

function client(extra: Record<string, string> = {}) {
  return new AnthropicClient({
    apiKey: "sk-ant-api03-test",
    adminApiKey: "sk-ant-admin01-test",
    ...extra,
  });
}

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("organizationKind", () => {
  it("tells Enterprise from Console by the disjoint roles, and gives up on users only", () => {
    expect(organizationKind([{ id: "a", role: "primary_owner" }])).toBe("enterprise");
    expect(
      organizationKind([
        { id: "a", role: "admin" },
        { id: "b", role: "user" },
      ]),
    ).toBe("console");
    expect(organizationKind([{ id: "a", role: "user" }])).toBe("unknown");
  });
});

describe("analyticsWindow", () => {
  it("reads the threshold plus the reporting lag, and never before 2026-01-01", () => {
    expect(analyticsWindow(30, NOW)).toEqual({
      startingDate: "2026-09-10",
      endingDate: "2026-10-12",
      windowDays: 30,
    });
    expect(analyticsWindow(365, NOW)).toEqual({
      startingDate: "2026-01-01",
      endingDate: "2026-10-12",
      windowDays: 282,
    });
  });
});

describe("fetchSeats", () => {
  it("lists every Enterprise member at list price, with no activity without the analytics key", async () => {
    install((url) => {
      if (url.pathname === "/v1/organizations/users") {
        return url.searchParams.get("after_id")
          ? json({ data: ENTERPRISE_USERS.slice(2), has_more: false, last_id: "user_idle" })
          : json({ data: ENTERPRISE_USERS.slice(0, 2), has_more: true, last_id: "user_dev" });
      }
      return json({ error: "unexpected" }, 404);
    });
    const seats = await client().fetchSeats("acc", { lookbackDays: 30 });

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.anthropic.com/v1/organizations/users?limit=1000",
      "https://api.anthropic.com/v1/organizations/users?limit=1000&after_id=user_dev",
    ]);
    expect(calls.every((c) => c.key === "sk-ant-admin01-test")).toBe(true);
    expect(seats.map((s) => [s.memberId, s.removable])).toEqual([
      ["user_owner", false],
      ["user_dev", true],
      ["user_idle", true],
    ]);
    expect(seats[0]).toEqual({
      memberId: "user_owner",
      name: "Boss",
      email: "boss@acme.com",
      product: "Claude",
      category: "ai-assistant",
      seatType: "Claude Enterprise",
      price: {
        monthly: 20,
        currency: "USD",
        source: "list-price",
        note: "claude.com/pricing, 2026-10 (Enterprise, billed annually; usage is billed separately at API rates)",
      },
      activity: {
        basis: "none",
        lastActiveAt: null,
        source: "Add a Claude Enterprise Analytics API key to see activity",
      },
      assignedAt: "2026-01-05T00:00:00Z",
      removable: false,
      removalNote:
        "Owners, membership admins and the primary owner are removed in claude.ai organization settings, not through the API.",
      downgrade: null,
      resource: { resourceTypeId: "organization-user", externalId: "user_owner" },
    });
  });

  it("reads last activity from the analytics rollup with the analytics key", async () => {
    install((url) => {
      if (url.pathname === "/v1/organizations/users") {
        return json({ data: ENTERPRISE_USERS, has_more: false, last_id: "user_idle" });
      }
      if (url.pathname === "/v1/organizations/analytics/users") {
        return url.searchParams.get("page")
          ? json({
              data: [
                {
                  user: { id: "user_idle", email_address: "idle@acme.com" },
                  last_activity_date: null,
                },
              ],
              next_page: null,
            })
          : json({
              data: [
                {
                  user: { id: "user_dev", email_address: "dev@acme.com" },
                  last_activity_date: "2026-10-09",
                },
              ],
              next_page: "cursor_2",
            });
      }
      return json({ error: "unexpected" }, 404);
    });
    const seats = await client({ analyticsApiKey: "analytics-test-key" }).fetchSeats("acc", {
      lookbackDays: 30,
    });

    const analytics = calls.filter((c) => c.url.includes("/analytics/"));
    expect(analytics.map((c) => c.url)).toEqual([
      "https://api.anthropic.com/v1/organizations/analytics/users?starting_date=2026-09-10&ending_date=2026-10-12&limit=1000",
      "https://api.anthropic.com/v1/organizations/analytics/users?starting_date=2026-09-10&ending_date=2026-10-12&limit=1000&page=cursor_2",
    ]);
    expect(analytics.every((c) => c.key === "analytics-test-key")).toBe(true);

    const byId = Object.fromEntries(seats.map((s) => [s.memberId, s.activity]));
    expect(byId["user_dev"]).toMatchObject({
      basis: "usage-window",
      lastActiveAt: "2026-10-09",
      windowDays: 30,
    });
    expect(byId["user_idle"]).toMatchObject({ basis: "usage-window", lastActiveAt: null });
    // Missing from the rollup: no evidence either way.
    expect(byId["user_owner"]).toEqual({
      basis: "none",
      lastActiveAt: null,
      source: "Not in Claude Enterprise analytics",
    });
  });

  it("treats an omitted last_activity_date as no evidence, not as never used", async () => {
    install((url) => {
      if (url.pathname === "/v1/organizations/users") {
        return json({ data: ENTERPRISE_USERS, has_more: false });
      }
      return json({ data: [{ user: { id: "user_dev", email_address: "dev@acme.com" } }] });
    });
    const seats = await client({ analyticsApiKey: "analytics-test-key" }).fetchSeats("acc", {
      lookbackDays: 30,
    });
    expect(new Set(seats.map((s) => s.activity.basis))).toEqual(new Set(["none"]));
  });

  it("reports nothing for a Console organization or without an admin key", async () => {
    install(() =>
      json({
        data: [
          { id: "user_a", email: "a@acme.com", role: "admin" },
          { id: "user_b", email: "b@acme.com", role: "developer" },
        ],
        has_more: false,
      }),
    );
    expect(await client().fetchSeats("acc", { lookbackDays: 30 })).toEqual([]);
    const noAdmin = new AnthropicClient({ apiKey: "sk-ant-api03-test" });
    expect(await noAdmin.fetchSeats("acc", { lookbackDays: 30 })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("fails the read when a page fails", async () => {
    install((url) =>
      url.searchParams.get("after_id")
        ? json({ error: "boom" }, 500)
        : json({ data: ENTERPRISE_USERS, has_more: true, last_id: "user_idle" }),
    );
    await expect(client().fetchSeats("acc", { lookbackDays: 30 })).rejects.toThrow(/500/);
  });
});

describe("removeSeat", () => {
  it("deletes the member with the admin key", async () => {
    install(() => json({ type: "user_deleted", id: "user_dev" }));
    const result = await client().removeSeat("acc", { memberId: "user_dev" });
    expect(calls).toEqual([
      {
        url: "https://api.anthropic.com/v1/organizations/users/user_dev",
        method: "DELETE",
        key: "sk-ant-admin01-test",
      },
    ]);
    expect(result.effective).toBe("end-of-cycle");
  });

  it("explains a 400 (admin role or SCIM)", async () => {
    install(() => json({ error: { type: "invalid_request_error" } }, 400));
    await expect(client().removeSeat("acc", { memberId: "user_owner" })).rejects.toThrow(
      /identity provider/,
    );
  });
});

describe("anthropicSeatRemediationCommands", () => {
  const seat: RemediationSeat = {
    memberId: "user_01AbCdEfGhIjKlMnOpQrSt",
    seatKey: "",
    email: "jane@example.com",
    login: null,
    name: "Jane",
    seatType: "Claude Enterprise",
    targetSeatType: null,
    context: {},
  };

  it("is wired on the plugin", () => {
    expect(plugin.seatRemediationCommands).toBe(anthropicSeatRemediationCommands);
    expect(plugin.manifest.seats).toEqual({ products: ["Claude"], removal: true });
  });

  it("inspects, then removes", () => {
    const commands = anthropicSeatRemediationCommands({ reason: "inactive", seat });
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS https://api.anthropic.com/v1/organizations/users/user_01AbCdEfGhIjKlMnOpQrSt -H "x-api-key: $ANTHROPIC_ADMIN_KEY" -H 'anthropic-version: 2023-06-01'",
        "curl -sS -X DELETE https://api.anthropic.com/v1/organizations/users/user_01AbCdEfGhIjKlMnOpQrSt -H "x-api-key: $ANTHROPIC_ADMIN_KEY" -H 'anthropic-version: 2023-06-01'",
      ]
    `);
    expect(commands.flatMap((c) => c.placeholders?.map((p) => p.name))).toEqual([
      "ANTHROPIC_ADMIN_KEY",
      "ANTHROPIC_ADMIN_KEY",
    ]);
    expect(anthropicSeatRemediationCommands({ reason: "duplicate", seat })).toHaveLength(2);
  });

  it("has nothing for a downgrade or a seat with no id", () => {
    expect(anthropicSeatRemediationCommands({ reason: "downgrade", seat })).toEqual([]);
    expect(
      anthropicSeatRemediationCommands({ reason: "inactive", seat: { ...seat, memberId: "" } }),
    ).toEqual([]);
  });
});
