import { beforeEach, describe, expect, it } from "vitest";
import type { HostServices, SeatRemediationFinding } from "@infrawrench/plugin-base";
import { normalizeSeatRecords } from "@infrawrench/plugin-base";
import { OktaClient } from "../client.js";
import { plugin } from "../plugin.js";
import { oktaSeatRemediationCommands } from "../remediation.js";

interface Call {
  url: string;
  method: string;
}
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let calls: Call[] = [];

function client(handler: (call: Call) => Reply, extra: Record<string, string> = {}) {
  const services: HostServices = {
    http: {
      request: async (req) => {
        const call = { url: req.url, method: req.method };
        calls.push(call);
        const res = handler(call);
        return {
          status: res.status ?? 200,
          headers: res.headers ?? {},
          body: res.body === undefined ? "" : JSON.stringify(res.body),
        };
      },
    },
  };
  return new OktaClient({ orgUrl: "acme.okta.com", apiToken: "tok", ...extra }, services);
}

const user = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  created: "2025-01-01T00:00:00.000Z",
  activated: "2025-01-02T00:00:00.000Z",
  lastLogin: "2026-09-30T10:00:00.000Z",
  profile: {
    login: `${id}@acme.com`,
    email: `${id.toUpperCase()}@Acme.com`,
    firstName: "Ada",
    lastName: id,
  },
  ...extra,
});

beforeEach(() => {
  calls = [];
});

describe("fetchSeats", () => {
  it("lists licensed users across every page with last sign-in evidence", async () => {
    const c = client((call) => {
      if (call.url.includes("after=p2"))
        return {
          body: [
            user("u3", "STAGED"),
            user("u4", "SUSPENDED", { lastLogin: null, activated: null }),
          ],
        };
      return {
        body: [user("u1", "ACTIVE"), user("u2", "PROVISIONED", { lastLogin: null })],
        headers: {
          link: '<https://acme.okta.com/api/v1/users?limit=200>; rel="self", <https://acme.okta.com/api/v1/users?after=p2&limit=200>; rel="next"',
        },
      };
    });
    const seats = await c.fetchSeats("acct", { lookbackDays: 30 });
    expect(calls.map((x) => x.url)).toEqual([
      "https://acme.okta.com/api/v1/users?limit=200",
      "https://acme.okta.com/api/v1/users?after=p2&limit=200",
    ]);
    expect(seats.map((s) => s.memberId)).toEqual(["u1", "u2", "u4"]);
    expect(seats[0]).toMatchObject({
      email: "u1@acme.com",
      login: "u1@acme.com",
      name: "Ada u1",
      product: "Okta",
      category: "identity",
      seatType: "User",
      activity: { basis: "last-login", lastActiveAt: "2026-09-30T10:00:00.000Z" },
      assignedAt: "2025-01-02T00:00:00.000Z",
      removable: true,
      context: { orgUrl: "https://acme.okta.com" },
      resource: { resourceTypeId: "user", externalId: "u1" },
      price: { monthly: 6, currency: "USD", source: "list-price" },
    });
    expect(seats[0]!.price!.note).toMatch(/okta\.com\/pricing, 2026-10/);
    // Never signed in: null date, assignment date from `created` when never activated.
    expect(seats[2]).toMatchObject({
      seatType: "User (suspended)",
      activity: { basis: "last-login", lastActiveAt: null },
      assignedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(normalizeSeatRecords(seats)).toHaveLength(3);
  });

  it("uses the configured contract price", async () => {
    const c = client(() => ({ body: [user("u1", "ACTIVE")] }), { seatPriceMonthly: "11.5" });
    const [seat] = await c.fetchSeats("acct", { lookbackDays: 30 });
    expect(seat!.price).toEqual({ monthly: 11.5, currency: "USD", source: "configured" });
  });

  it("throws when any page fails instead of returning a partial list", async () => {
    const c = client((call) =>
      call.url.includes("after=p2")
        ? { status: 500, body: { errorSummary: "boom" } }
        : {
            body: [user("u1", "ACTIVE")],
            headers: { link: '<https://acme.okta.com/api/v1/users?after=p2>; rel="next"' },
          },
    );
    await expect(c.fetchSeats("acct", { lookbackDays: 30 })).rejects.toThrow(/500/);
  });
});

describe("removeSeat", () => {
  it("deactivates the user", async () => {
    const c = client((call) =>
      call.method === "GET" ? { body: user("u1", "ACTIVE") } : { body: {} },
    );
    const result = await c.removeSeat("acct", { memberId: "u1" });
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET https://acme.okta.com/api/v1/users/u1",
      "POST https://acme.okta.com/api/v1/users/u1/lifecycle/deactivate",
    ]);
    expect(result.effective).toBe("end-of-cycle");
  });

  it("does nothing for a user already deactivated", async () => {
    const c = client(() => ({ body: user("u1", "DEPROVISIONED") }));
    await c.removeSeat("acct", { memberId: "u1" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces Okta's refusal", async () => {
    const c = client((call) =>
      call.method === "GET"
        ? { body: user("u1", "ACTIVE") }
        : { status: 403, body: { errorSummary: "You do not have permission" } },
    );
    await expect(c.removeSeat("acct", { memberId: "u1" })).rejects.toThrow(/permission/);
  });
});

describe("seat manifest", () => {
  it("declares seats with removal and wires the generator", () => {
    expect(plugin.manifest.seats).toEqual({ products: ["Okta"], removal: true });
    expect(plugin.seatRemediationCommands).toBe(oktaSeatRemediationCommands);
  });
});

describe("oktaSeatRemediationCommands", () => {
  const finding = (
    reason: SeatRemediationFinding["reason"],
    context: Record<string, string> = { orgUrl: "https://acme.okta.com" },
  ): SeatRemediationFinding => ({
    reason,
    seat: {
      memberId: "00u1abc",
      seatKey: "",
      email: "ada@acme.com",
      login: "ada@acme.com",
      name: "Ada",
      seatType: "User",
      targetSeatType: null,
      context,
    },
  });

  it("inspects then deactivates an inactive user", () => {
    expect(oktaSeatRemediationCommands(finding("inactive"))).toMatchInlineSnapshot(`
      [
        {
          "command": "curl -sS --fail-with-body https://acme.okta.com/api/v1/users/00u1abc -H "Authorization: SSWS $OKTA_API_TOKEN" -H 'Accept: application/json'",
          "description": "Show ada@acme.com's status, last sign-in and activation date before deactivating.",
          "destructive": false,
          "placeholders": [
            {
              "description": "An Okta API token from an admin allowed to manage users (Security, API, Tokens in the Admin Console)",
              "name": "OKTA_API_TOKEN",
            },
          ],
          "tool": "curl",
        },
        {
          "command": "curl -sS --fail-with-body -X POST https://acme.okta.com/api/v1/users/00u1abc/lifecycle/deactivate -H "Authorization: SSWS $OKTA_API_TOKEN" -H 'Accept: application/json'",
          "description": "Deactivate the user to free the licence. Okta deprovisions every app assignment, which can delete their data in those apps; reactivating later does not restore the assignments.",
          "destructive": true,
          "placeholders": [
            {
              "description": "An Okta API token from an admin allowed to manage users (Security, API, Tokens in the Admin Console)",
              "name": "OKTA_API_TOKEN",
            },
          ],
          "tool": "curl",
        },
      ]
    `);
  });

  it("uses the same commands for a duplicate, and a placeholder without the org URL", () => {
    const cmds = oktaSeatRemediationCommands(finding("duplicate", {}));
    expect(cmds).toHaveLength(2);
    expect(cmds[1]!.command).toContain('"$OKTA_ORG_URL/api/v1/users/00u1abc/lifecycle/deactivate"');
    expect(cmds[1]!.placeholders!.map((p) => p.name)).toEqual(["OKTA_API_TOKEN", "OKTA_ORG_URL"]);
  });

  it("has nothing for a downgrade", () => {
    expect(oktaSeatRemediationCommands(finding("downgrade"))).toEqual([]);
  });
});
