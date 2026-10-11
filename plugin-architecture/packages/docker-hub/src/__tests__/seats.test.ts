import { describe, expect, it } from "vitest";
import type { SeatRemediationFinding } from "@infrawrench/plugin-base";
import { normalizeSeatRecords } from "@infrawrench/plugin-base";
import { DockerHubClient } from "../client.js";
import { plugin } from "../plugin.js";
import { dockerHubSeatRemediationCommands } from "../remediation.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp((call) => {
    if (call.url.pathname === "/v2/auth/token") return { access_token: "jwt-1" };
    return route(call);
  });
  return {
    c: new DockerHubClient(
      { username: "alice", token: "dckr_pat_x", namespaces: "alice, acme", ...creds },
      { http } as never,
    ),
    calls,
  };
}

const member = (username: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${username}`,
  username,
  full_name: `Full ${username}`,
  email: `${username}@Acme.com`,
  role: "Member",
  date_joined: "2019-01-01T00:00:00Z",
  ...extra,
});

describe("fetchSeats", () => {
  it("lists every organization member across pages, skipping the personal namespace", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname !== "/v2/orgs/acme/members") throw new Error(call.url.pathname);
      if (call.url.searchParams.get("page") === "2")
        return {
          results: [
            member("carol", { last_logged_in_at: null, last_seen_at: null }),
            member("pending", { role: "Invitee" }),
          ],
          next: null,
        };
      return {
        results: [
          member("alice", {
            role: "Owner",
            last_logged_in_at: "2026-09-01T00:00:00Z",
            last_seen_at: "2026-10-01T00:00:00Z",
          }),
          member("bob", { role: "Editor" }),
        ],
        next: "https://hub.docker.com/v2/orgs/acme/members?page=2&page_size=100",
      };
    });
    const seats = await c.fetchSeats("acct", { lookbackDays: 30 });
    expect(
      calls.filter((x) => x.url.pathname !== "/v2/auth/token").map((x) => x.url.search),
    ).toEqual(["?page_size=100", "?page=2&page_size=100"]);
    expect(seats.map((s) => s.memberId)).toEqual(["acme/alice", "acme/bob", "acme/carol"]);
    expect(seats[0]).toMatchObject({
      email: "alice@acme.com",
      login: "alice",
      name: "Full alice",
      product: "Docker",
      category: "other",
      seatType: "Owner",
      activity: { basis: "last-login", lastActiveAt: "2026-10-01T00:00:00Z" },
      assignedAt: null,
      // The only owner cannot be removed.
      removable: false,
      context: { org: "acme" },
      resource: { resourceTypeId: "dockerhub-member", externalId: "acme/alice" },
      price: { monthly: 15, currency: "USD", source: "list-price" },
    });
    // No insights: activity unknown, never flagged.
    expect(seats[1]).toMatchObject({
      seatType: "Editor",
      activity: { basis: "none", lastActiveAt: null },
      removable: true,
    });
    expect(seats[2]!.activity.basis).toBe("none");
    expect(normalizeSeatRecords(seats)).toHaveLength(3);
  });

  it("uses the configured seat price", async () => {
    const { c } = client(() => ({ results: [member("bob")], next: null }), {
      seatPriceMonthly: "24",
    });
    const [seat] = await c.fetchSeats("acct", { lookbackDays: 30 });
    expect(seat!.price).toEqual({ monthly: 24, currency: "USD", source: "configured" });
  });

  it("fails the read when an organization cannot be listed", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "forbidden" } }));
    await expect(c.fetchSeats("acct", { lookbackDays: 30 })).rejects.toThrow(
      /cannot list the members of acme/,
    );
  });

  it("fails the read when a later page fails", async () => {
    const { c } = client((call) =>
      call.url.searchParams.get("page") === "2"
        ? { status: 500, body: { message: "boom" } }
        : { results: [member("bob")], next: "https://hub.docker.com/v2/orgs/acme/members?page=2" },
    );
    await expect(c.fetchSeats("acct", { lookbackDays: 30 })).rejects.toThrow(/500/);
  });
});

describe("removeSeat", () => {
  it("removes the member from the organization", async () => {
    const { c, calls } = client(() => ({ status: 204 }));
    const result = await c.removeSeat("acct", {
      memberId: "acme/bob",
      login: "bob",
      context: { org: "acme" },
    });
    const del = calls.find((x) => x.method === "DELETE")!;
    expect(del.url.pathname).toBe("/v2/orgs/acme/members/bob");
    expect(result.effective).toBe("end-of-cycle");
    expect(result.message).toMatch(/reduce the seat count/);
  });

  it("surfaces Docker's refusal", async () => {
    const { c } = client(() => ({ status: 400, body: { message: "cannot remove last owner" } }));
    await expect(c.removeSeat("acct", { memberId: "acme/alice" })).rejects.toThrow(/last owner/);
  });
});

describe("dockerHubSeatRemediationCommands", () => {
  const finding = (reason: SeatRemediationFinding["reason"]): SeatRemediationFinding => ({
    reason,
    seat: {
      memberId: "acme/bob",
      seatKey: "",
      email: "bob@acme.com",
      login: "bob",
      name: "Bob",
      seatType: "Member",
      targetSeatType: null,
      context: { org: "acme" },
    },
  });

  it("is wired with the manifest declaration", () => {
    expect(plugin.manifest.seats).toEqual({ products: ["Docker"], removal: true });
    expect(plugin.seatRemediationCommands).toBe(dockerHubSeatRemediationCommands);
  });

  it("gets a token, shows the member, then removes them", () => {
    expect(dockerHubSeatRemediationCommands(finding("inactive")).map((c) => c.command))
      .toMatchInlineSnapshot(`
      [
        "DOCKERHUB_JWT=$(jq -n --arg identifier "$DOCKERHUB_USERNAME" --arg secret "$DOCKERHUB_TOKEN" '{identifier: $identifier, secret: $secret}' | curl -sSf -X POST https://hub.docker.com/v2/auth/token -H 'Content-Type: application/json' --data-binary @- | jq -r .access_token)",
        "curl -sS --fail-with-body 'https://hub.docker.com/v2/orgs/acme/members?page_size=100&search=bob' -H "Authorization: Bearer $DOCKERHUB_JWT" | jq '.results[] | select(.username == "bob")'",
        "curl -sS --fail-with-body -X DELETE https://hub.docker.com/v2/orgs/acme/members/bob -H "Authorization: Bearer $DOCKERHUB_JWT"",
      ]
    `);
    expect(dockerHubSeatRemediationCommands(finding("duplicate"))).toHaveLength(3);
  });

  it("has nothing for a downgrade", () => {
    expect(dockerHubSeatRemediationCommands(finding("downgrade"))).toEqual([]);
  });
});
