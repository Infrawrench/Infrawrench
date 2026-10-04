import type { CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { DevinClient } from "../client.js";
import { allocateOrgRows, splitDay } from "../cost-data.js";
import { day, makeHttp, page, reply } from "./helpers.js";

const ORG = { org_id: "org-1", name: "Acme" };
const RANGE = { fromDate: "2026-10-01", toDate: "2026-10-02" };

const total = (rows: CostRow[], date?: string) =>
  Math.round(
    rows.filter((r) => !date || r.date === date).reduce((a, r) => a + (r.usageAmount ?? 0), 0) *
      1e6,
  ) / 1e6;

const find = (rows: CostRow[], pred: (r: CostRow) => boolean) => rows.filter(pred);

describe("splitDay", () => {
  it("uses Devin's product buckets and files any remainder under Devin sessions", () => {
    expect(
      splitDay({
        acus: 10,
        acus_by_product: { devin: 6, cascade: 2, terminal: 0, automation: null },
      }),
    ).toMatchObject({ devin: 8, cascade: 2, terminal: 0, automation: 0, review: 0 });
  });
});

describe("allocateOrgRows", () => {
  const base = {
    org: ORG,
    orgDays: [
      { date: day("2026-10-01"), acus: 10, acus_by_product: { devin: 8, cascade: 2, terminal: 0 } },
      { date: day("2026-10-02"), acus: 5, acus_by_product: { devin: 5, cascade: 0, terminal: 0 } },
    ],
    principals: [{ key: "user:u1", kind: "user" as const, id: "u1", label: "Ada" }],
    principalDays: new Map([
      [
        "user:u1",
        [
          {
            date: day("2026-10-01"),
            acus: 8,
            acus_by_product: { devin: 6, cascade: 2, terminal: 0 },
          },
          {
            date: day("2026-10-02"),
            acus: 3,
            acus_by_product: { devin: 3, cascade: 0, terminal: 0 },
          },
        ],
      ],
    ]),
    playbooks: new Map([["p1", { playbook_id: "p1", title: "Upgrade deps" }]]),
    acuPrice: 2.25,
    range: RANGE,
  };
  const split = (devin: number) => ({ devin, automation: 0, cascade: 0, terminal: 0, review: 0 });
  const s1 = {
    session_id: "s1",
    user_id: "u1",
    playbook_id: "p1",
    tags: ["b", "a"],
    origin: "slack",
  };
  const s2 = { session_id: "s2", user_id: "u1" };

  it("attributes sessions, then user residue, then org residue, summing to the org total", () => {
    const rows = allocateOrgRows({
      ...base,
      sessions: [
        { session: s1, days: [{ day: "2026-10-01", split: split(4) }] },
        {
          session: s2,
          days: [
            { day: "2026-10-01", split: split(1) },
            { day: "2026-10-02", split: split(3) },
          ],
        },
      ],
    });
    expect(total(rows, "2026-10-01")).toBe(10);
    expect(total(rows, "2026-10-02")).toBe(5);

    const s1Rows = find(rows, (r) => r.resourceId === "org-1/s1");
    expect(s1Rows).toHaveLength(1);
    expect(s1Rows[0]).toMatchObject({
      date: "2026-10-01",
      service: "Devin sessions",
      usageAmount: 4,
      usageUnit: "ACU",
      amount: 9,
      currency: "USD",
      tags: {
        organization: "Acme",
        user: "Ada",
        playbook: "Upgrade deps",
        session_tag: "a+b",
        origin: "slack",
      },
    });

    // Ada's Cascade use has no session: a user-only row.
    const cascade = find(rows, (r) => r.service === "Cascade");
    expect(cascade).toEqual([
      expect.objectContaining({ usageAmount: 2, tags: { organization: "Acme", user: "Ada" } }),
    ]);
    expect(cascade[0]!.resourceId).toBeUndefined();

    // Day 1 Devin: 8 org, 6 Ada, sessions 5: Ada keeps 1, the org 2.
    const userOnly = find(
      rows,
      (r) =>
        r.date === "2026-10-01" &&
        r.service === "Devin sessions" &&
        !r.resourceId &&
        !!r.tags?.["user"],
    );
    expect(userOnly.map((r) => r.usageAmount)).toEqual([1]);
    const orgOnly = find(rows, (r) => r.date === "2026-10-01" && !r.tags?.["user"]);
    expect(orgOnly.map((r) => r.usageAmount)).toEqual([2]);
  });

  it("scales sessions down when they exceed the user's total, and users down to the org total", () => {
    const rows = allocateOrgRows({
      ...base,
      orgDays: [
        {
          date: day("2026-10-01"),
          acus: 4,
          acus_by_product: { devin: 4, cascade: 0, terminal: 0 },
        },
      ],
      principalDays: new Map([
        [
          "user:u1",
          [
            {
              date: day("2026-10-01"),
              acus: 6,
              acus_by_product: { devin: 6, cascade: 0, terminal: 0 },
            },
          ],
        ],
      ]),
      sessions: [{ session: s1, days: [{ day: "2026-10-01", split: split(12) }] }],
    });
    expect(total(rows)).toBe(4);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceId).toBe("org-1/s1");
  });

  it("drops days outside the requested range", () => {
    const rows = allocateOrgRows({
      ...base,
      sessions: [{ session: s2, days: [{ day: "2026-09-30", split: split(3) }] }],
    });
    expect(rows.every((r) => r.date >= "2026-10-01" && r.date <= "2026-10-02")).toBe(true);
  });
});

describe("fetchCostData", () => {
  function devinApi(overrides: Partial<Record<string, unknown>> = {}) {
    return makeHttp((c) => {
      if (c.path in overrides) return overrides[c.path];
      switch (c.path) {
        case "/v3/self":
          return {
            principal_type: "service_user",
            service_user_id: "su1",
            service_user_name: "CI",
            org_id: "org-1",
          };
        case "/v3/organizations/org-1/consumption/daily":
          return {
            total_acus: 6,
            consumption_by_date: [
              {
                date: day("2026-10-01"),
                acus: 6,
                acus_by_product: { devin: 6, cascade: 0, terminal: 0 },
              },
            ],
          };
        case "/v3beta1/organizations/org-1/members/users":
          return page([
            { user_id: "u1", name: "Ada", email: "ada@example.com", role_assignments: [] },
          ]);
        case "/v3/organizations/org-1/sessions":
          return page([
            {
              session_id: "s1",
              user_id: "u1",
              tags: [],
              status: "exit",
              created_at: day("2026-10-01") + 100,
              updated_at: day("2026-10-01") + 4000,
              acus_consumed: 2,
            },
            {
              session_id: "s2",
              service_user_id: "su1",
              tags: ["nightly"],
              status: "running",
              created_at: day("2026-09-29"),
              updated_at: day("2026-10-01") + 50,
              acus_consumed: 9,
            },
          ]);
        case "/v3/organizations/org-1/playbooks":
          return page([]);
        case "/v3/organizations/org-1/consumption/daily/users/u1":
          return {
            consumption_by_date: [
              {
                date: day("2026-10-01"),
                acus: 3,
                acus_by_product: { devin: 3, cascade: 0, terminal: 0 },
              },
            ],
          };
        case "/v3/organizations/org-1/consumption/daily/service-users/su1":
          return {
            consumption_by_date: [
              {
                date: day("2026-10-01"),
                acus: 3,
                acus_by_product: { devin: 3, cascade: 0, terminal: 0 },
              },
            ],
          };
        case "/v3/organizations/org-1/consumption/daily/sessions/s2":
          return {
            consumption_by_date: [
              {
                date: day("2026-09-30"),
                acus: 6,
                acus_by_product: { devin: 6, cascade: 0, terminal: 0 },
              },
              {
                date: day("2026-10-01"),
                acus: 3,
                acus_by_product: { devin: 3, cascade: 0, terminal: 0 },
              },
            ],
          };
        default:
          return reply(404, { detail: `unexpected ${c.path}` });
      }
    });
  }

  it("reads consumption with PST day bounds, a Bearer token, and attributes service users", async () => {
    const { http, calls } = devinApi();
    const client = new DevinClient({ apiKey: "cog_x", acuPrice: "2" }, { http } as never);
    const out = await client.fetchCostData("acct", {
      fromDate: "2026-10-01",
      toDate: "2026-10-01",
    });
    expect(out.degraded).toBe(false);
    expect(total(out.rows)).toBe(6);

    const consumption = calls.find((c) => c.path === "/v3/organizations/org-1/consumption/daily")!;
    expect(consumption.headers["Authorization"]).toBe("Bearer cog_x");
    expect(consumption.query.get("time_after")).toBe(String(day("2026-10-01")));
    expect(consumption.query.get("time_before")).toBe(String(day("2026-10-02")));

    // s1 began and ended on one day: no per-session request.
    expect(calls.some((c) => c.path.endsWith("/sessions/s1"))).toBe(false);
    const s1 = out.rows.find((r) => r.resourceId === "org-1/s1")!;
    expect(s1).toMatchObject({ usageAmount: 2, amount: 4, tags: { user: "Ada" } });
    const s2 = out.rows.find((r) => r.resourceId === "org-1/s2")!;
    expect(s2).toMatchObject({ usageAmount: 3, tags: { user: "CI", session_tag: "nightly" } });
  });

  it("asks for the consumption permission when every org refuses", async () => {
    const { http } = devinApi({
      "/v3/organizations/org-1/consumption/daily": reply(403, { detail: "forbidden" }),
    });
    const client = new DevinClient({ apiKey: "cog_x" }, { http } as never);
    await expect(client.fetchCostData("acct", RANGE)).rejects.toBeInstanceOf(CostSetupError);
  });

  it("writes nothing and makes no further calls for an org with no consumption", async () => {
    const { http, calls } = devinApi({
      "/v3/organizations/org-1/consumption/daily": { total_acus: 0, consumption_by_date: [] },
    });
    const client = new DevinClient({ apiKey: "cog_x" }, { http } as never);
    const out = await client.fetchCostData("acct", RANGE);
    expect(out.rows).toEqual([]);
    expect(calls.map((c) => c.path)).toEqual([
      "/v3/self",
      "/v3/organizations/org-1/consumption/daily",
    ]);
  });
});
