import { describe, expect, it, vi } from "vitest";
import type { SeatRemediationFinding } from "@infrawrench/plugin-base";
import { normalizeSeatRecords } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { tailscaleSeatRemediationCommands } from "../remediation.js";
import { mapTailscaleSeats, tailscaleSeatPrice } from "../seats.js";

const user = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName: `User ${id}`,
  loginName: `${id}@Example.com`,
  created: "2025-01-01T00:00:00Z",
  type: "member",
  role: "member",
  status: "active",
  deviceCount: 2,
  lastSeen: "2026-10-01T00:00:00Z",
  currentlyConnected: false,
  ...extra,
});

const USERS = [
  user("1", { role: "owner" }),
  user("2", { status: "idle", lastSeen: "2026-06-01T00:00:00Z" }),
  user("3", { status: "suspended" }),
  user("4", { status: "needs-approval", lastSeen: "" }),
  user("5", { type: "shared" }),
  user("6", { currentlyConnected: true }),
  user("7", { lastSeen: undefined }),
];

function client(reply: (url: string, method: string) => { status?: number; body?: unknown }) {
  const request = vi.fn(async (req: { url: string; method: string }) => {
    const r = reply(req.url, req.method);
    return { status: r.status ?? 200, body: r.body === undefined ? "" : JSON.stringify(r.body) };
  });
  return {
    request,
    c: plugin.createClient({ apiKey: "tskey-api-secret", tailnet: "example.com" }, {
      http: { request },
    } as never),
  };
}

describe("fetchSeats", () => {
  it("lists members that occupy a seat with their last-seen evidence", async () => {
    const { request, c } = client(() => ({ body: { users: USERS } }));
    const seats = await c.fetchSeats!("acct", { lookbackDays: 30 });
    expect(request.mock.calls[0]![0].url).toBe(
      "https://api.tailscale.com/api/v2/tailnet/example.com/users?type=member",
    );
    expect(seats.map((s) => s.memberId)).toEqual(["1", "2", "6"]);
    expect(seats[1]).toMatchObject({
      email: "2@example.com",
      login: "2@Example.com",
      name: "User 2",
      product: "Tailscale",
      category: "other",
      seatType: "Tailnet user",
      activity: { basis: "last-activity", lastActiveAt: "2026-06-01T00:00:00Z" },
      assignedAt: "2025-01-01T00:00:00Z",
      removable: true,
      context: { tailnet: "example.com" },
      resource: { resourceTypeId: "user", externalId: "2" },
      price: { monthly: 8, currency: "USD", source: "list-price" },
    });
    // The owner cannot be suspended.
    expect(seats[0]!.removable).toBe(false);
    expect(normalizeSeatRecords(seats)).toHaveLength(3);
  });

  it("treats a connected user as active now", () => {
    const now = new Date("2026-10-12T00:00:00Z");
    const [seat] = mapTailscaleSeats(
      [user("6", { currentlyConnected: true })],
      "-",
      tailscaleSeatPrice(""),
      now,
    );
    expect(seat!.activity.lastActiveAt).toBe(now.toISOString());
  });

  it("uses the configured price, including 0 for the free plan", () => {
    expect(tailscaleSeatPrice("0")).toEqual({ monthly: 0, currency: "USD", source: "configured" });
    expect(tailscaleSeatPrice("18").monthly).toBe(18);
    expect(tailscaleSeatPrice("abc").source).toBe("list-price");
  });

  it("throws on an API failure", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "forbidden" } }));
    await expect(c.fetchSeats!("acct", { lookbackDays: 30 })).rejects.toThrow(/403/);
  });
});

describe("removeSeat", () => {
  it("suspends a member of this tailnet", async () => {
    const { request, c } = client((_url, method) =>
      method === "GET" ? { body: { users: USERS } } : { body: {} },
    );
    const result = await c.removeSeat!("acct", { memberId: "2" });
    const post = request.mock.calls.find((call) => call[0].method === "POST")!;
    expect(post[0].url).toBe("https://api.tailscale.com/api/v2/users/2/suspend");
    expect(result.effective).toBe("end-of-cycle");
  });

  it("refuses the owner and users outside the tailnet", async () => {
    const { request, c } = client(() => ({ body: { users: USERS } }));
    await expect(c.removeSeat!("acct", { memberId: "1" })).rejects.toThrow(/owner/);
    await expect(c.removeSeat!("acct", { memberId: "999" })).rejects.toThrow(/not a member/);
    expect(request.mock.calls.every((call) => call[0].method === "GET")).toBe(true);
  });
});

describe("tailscaleSeatRemediationCommands", () => {
  const finding = (reason: SeatRemediationFinding["reason"]): SeatRemediationFinding => ({
    reason,
    seat: {
      memberId: "uXYZ123",
      seatKey: "",
      email: "ada@example.com",
      login: "ada@example.com",
      name: "Ada",
      seatType: "Tailnet user",
      targetSeatType: null,
      context: { tailnet: "example.com" },
    },
  });

  it("is wired with the manifest declaration", () => {
    expect(plugin.manifest.seats).toEqual({ products: ["Tailscale"], removal: true });
    expect(plugin.seatRemediationCommands).toBe(tailscaleSeatRemediationCommands);
  });

  it("shows the user, then suspends them", () => {
    expect(tailscaleSeatRemediationCommands(finding("inactive"))).toMatchInlineSnapshot(`
      [
        {
          "command": "curl -sS --fail-with-body https://api.tailscale.com/api/v2/users/uXYZ123 -H "Authorization: Bearer $TAILSCALE_API_KEY"",
          "description": "Show ada@example.com's status, last seen time and device count before suspending.",
          "destructive": false,
          "placeholders": [
            {
              "description": "A Tailscale API access token, or an OAuth access token with the users scope",
              "name": "TAILSCALE_API_KEY",
            },
          ],
          "tool": "curl",
        },
        {
          "command": "curl -sS --fail-with-body -X POST https://api.tailscale.com/api/v2/users/uXYZ123/suspend -H "Authorization: Bearer $TAILSCALE_API_KEY"",
          "description": "Suspend the user to free the seat; their devices stay but cannot exchange traffic, and Restore undoes it. Then lower the seat count in billing, or Tailscale keeps charging for the empty seat.",
          "destructive": false,
          "placeholders": [
            {
              "description": "A Tailscale API access token, or an OAuth access token with the users scope",
              "name": "TAILSCALE_API_KEY",
            },
          ],
          "tool": "curl",
        },
      ]
    `);
    expect(tailscaleSeatRemediationCommands(finding("duplicate"))).toHaveLength(2);
  });

  it("has nothing for a downgrade or an unsafe id", () => {
    expect(tailscaleSeatRemediationCommands(finding("downgrade"))).toEqual([]);
    const bad = finding("inactive");
    bad.seat.memberId = "1; rm -rf ~";
    expect(tailscaleSeatRemediationCommands(bad)).toEqual([]);
  });
});
