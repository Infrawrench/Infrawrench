import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAccounts, runNrql } from "../api.js";
import { NewRelicClient } from "../client.js";
import { ctxWith, makeHttp } from "./helpers.js";

const creds = { region: "us", apiKey: "NRAK-TEST", accountId: "42" };
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

const entityPage = (results: unknown) => ({ actor: { entitySearch: { results } } });
const alertsPage = (alerts: unknown) => ({ actor: { account: { alerts } } });
const accountsOf = (n: number) => ({
  actor: { accounts: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `a${i + 1}` })) },
});
const FORBIDDEN = { errors: [{ message: "denied", extensions: { errorClass: "FORBIDDEN" } }] };
const emptyPolicies = alertsPage({ policiesSearch: { nextCursor: null, policies: [] } });

function client(route: Parameters<typeof makeHttp>[0]) {
  const { http, calls } = makeHttp(route);
  return { c: hostClient(new NewRelicClient(creds, { http } as never)), calls };
}

function captureUnread() {
  const prefixes: string[] = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: { idPrefixes?: string[] }) => {
    prefixes.push(...(part.idPrefixes ?? []));
  });
  return prefixes;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.useRealTimers();
});

describe("page caps", () => {
  it("throws when entity search never ends, after 100,000 rows' worth of pages", async () => {
    const { c, calls } = client(() =>
      entityPage({ nextCursor: "more", entities: [{ guid: "G", name: "x" }] }),
    );
    await expect(c.listResources("host", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(500);
  });

  it("throws when alert policies never end", async () => {
    const { c, calls } = client((call) => {
      if (call.query.includes("accounts")) return accountsOf(1);
      return alertsPage({ policiesSearch: { nextCursor: "more", policies: [{ id: "1" }] } });
    });
    await expect(c.listResources("alert-policy", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.query.includes("policiesSearch"))).toHaveLength(1000);
  });

  it("throws when NRQL conditions never end", async () => {
    const { c, calls } = client((call) => {
      if (call.query.includes("accounts")) return accountsOf(1);
      if (call.query.includes("policiesSearch")) return emptyPolicies;
      return alertsPage({
        nrqlConditionsSearch: { nextCursor: "more", nrqlConditions: [{ id: "1" }] },
      });
    });
    await expect(c.listResources("alert-condition", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.query.includes("nrqlConditionsSearch"))).toHaveLength(1000);
  });

  it("reads a list that was past the old cap of 50 pages", async () => {
    const { c } = client((call) => {
      const n = Number(call.variables["cursor"] ?? 0);
      return entityPage({
        nextCursor: n < 79 ? String(n + 1) : null,
        entities: [{ guid: `G${n}`, name: "x" }],
      });
    });
    await expect(c.listResources("host", "acct")).resolves.toHaveLength(80);
  });
});

describe("pages that are not lists", () => {
  it("rejects an entity page with its key renamed, first page and later", async () => {
    const first = client(() => entityPage({ nextCursor: null, rows: [] }));
    await expect(first.c.listResources("host", "acct")).rejects.toThrow("is not a list");
    const later = client((call) =>
      call.variables["cursor"]
        ? entityPage({ nextCursor: null, rows: [] })
        : entityPage({ nextCursor: "2", entities: [{ guid: "G", name: "x" }] }),
    );
    await expect(later.c.listResources("host", "acct")).rejects.toThrow("is not a list");
  });

  it("rejects alert pages with no list", async () => {
    const policies = client((call) =>
      call.query.includes("accounts") ? accountsOf(1) : alertsPage({ policiesSearch: null }),
    );
    await expect(policies.c.listResources("alert-policy", "acct")).rejects.toThrow("is not a list");
    const conditions = client((call) => {
      if (call.query.includes("accounts")) return accountsOf(1);
      if (call.query.includes("policiesSearch")) return emptyPolicies;
      return alertsPage({ nrqlConditionsSearch: { nextCursor: null } });
    });
    await expect(conditions.c.listResources("alert-condition", "acct")).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads a null list as empty, as NerdGraph may send one", async () => {
    const { c } = client(() => entityPage({ nextCursor: null, entities: null }));
    await expect(c.listResources("host", "acct")).resolves.toEqual([]);
  });

  it("rejects an account list with no accounts key", async () => {
    const { http } = makeHttp(() => ({ actor: {} }));
    await expect(listAccounts(ctxWith(http))).rejects.toThrow("is not a list");
  });

  it("rejects an NRQL answer with no results, which a cost read would store as no spend", async () => {
    const { http } = makeHttp(() => ({ actor: { account: { nrql: null } } }));
    await expect(runNrql(ctxWith(http), 42, "SELECT 1")).rejects.toThrow("is not a list");
  });
});

describe("errors alongside data in entity search", () => {
  const row = { guid: "G1", name: "x" };
  const errorAt = (path?: Array<string | number>) => ({
    message: "boom",
    ...(path ? { path } : {}),
  });
  const ROW_FIELD = ["actor", "entitySearch", "results", "entities", 0, "apmSummary"];

  it("keeps the rows when the error is inside one row's field", async () => {
    const { c } = client(() => ({
      data: entityPage({ nextCursor: null, entities: [row] }),
      errors: [errorAt(ROW_FIELD)],
    }));
    await expect(c.listResources("host", "acct")).resolves.toHaveLength(1);
  });

  it("fails when the failure nulled the whole results object", async () => {
    const { c } = client(() => ({
      data: entityPage(null),
      errors: [errorAt(["actor", "entitySearch", "results"])],
    }));
    await expect(c.listResources("host", "acct")).rejects.toThrow("boom");
  });

  it("fails when the failure nulled the cursor, which would read as the last page", async () => {
    const { c } = client(() => ({
      data: entityPage({ nextCursor: null, entities: [row] }),
      errors: [errorAt(["actor", "entitySearch", "results", "nextCursor"])],
    }));
    await expect(c.listResources("host", "acct")).rejects.toThrow("boom");
  });

  it("fails on an error that names no place", async () => {
    const { c } = client(() => ({
      data: entityPage({ nextCursor: null, entities: [row] }),
      errors: [errorAt()],
    }));
    await expect(c.listResources("host", "acct")).rejects.toThrow("boom");
  });

  it("fails when a row came back null, which a sync would read as deleted", async () => {
    const { c } = client(() => ({
      data: entityPage({ nextCursor: null, entities: [row, null] }),
      errors: [errorAt(["actor", "entitySearch", "results", "entities", 1, "guid"])],
    }));
    await expect(c.listResources("host", "acct")).rejects.toThrow("is not a list");
  });
});

describe("alerts across accounts", () => {
  const route = (n: number) => (call: { query: string; variables: Record<string, unknown> }) => {
    if (call.query.includes("accounts")) return accountsOf(n);
    return alertsPage({
      policiesSearch: {
        nextCursor: null,
        policies: [{ id: String(call.variables["accountId"]), name: "p" }],
      },
    });
  };

  it("reads 1,000 accounts a poll and names the rest, so they go stale and stay", async () => {
    const prefixes = captureUnread();
    const { c } = client(route(1100));
    const rows = await c.listResources("alert-policy", "acct");
    expect(rows).toHaveLength(1000);
    expect(prefixes).toHaveLength(100);
    const read = rows.map((r) => `acct:alert-policy:${r.fields["nrAccountId"]}:`);
    expect(new Set([...read, ...prefixes]).size).toBe(1100);
    // Account 4's prefix must not also vouch for account 42's rows.
    expect(prefixes.every((p) => /^acct:alert-policy:\d+:$/.test(p))).toBe(true);
  });

  it("reads every account where the host keeps no track of the rest", async () => {
    const { c } = client(route(1100));
    await expect(c.listResources("alert-policy", "acct")).resolves.toHaveLength(1100);
  });

  it("reads every account when they fit, naming nothing", async () => {
    const prefixes = captureUnread();
    const { c } = client(route(150));
    await expect(c.listResources("alert-policy", "acct")).resolves.toHaveLength(150);
    expect(prefixes).toEqual([]);
  });

  it("moves the run of accounts from one poll to the next", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const unreadAt = async (at: string) => {
      vi.setSystemTime(new Date(at));
      const prefixes = captureUnread();
      await client(route(1100)).c.listResources("alert-policy", "acct");
      return prefixes;
    };
    const first = await unreadAt("2026-11-07T10:00:00Z");
    const second = await unreadAt("2026-11-07T10:05:00Z");
    expect(second).not.toEqual(first);
  });

  it("names conditions under their own type", async () => {
    const prefixes = captureUnread();
    const { c } = client((call) => {
      if (call.query.includes("accounts")) return accountsOf(1001);
      if (call.query.includes("policiesSearch")) return emptyPolicies;
      return alertsPage({ nrqlConditionsSearch: { nextCursor: null, nrqlConditions: [] } });
    });
    await c.listResources("alert-condition", "acct");
    expect(prefixes).toHaveLength(1);
    expect(prefixes[0]).toMatch(/^acct:alert-condition:\d+:$/);
  });

  it("keeps the type's rows quietly when every account refuses the key", async () => {
    const prefixes = captureUnread();
    const { c } = client((call) => (call.query.includes("accounts") ? accountsOf(2) : FORBIDDEN));
    await expect(c.listResources("alert-policy", "acct")).resolves.toEqual([]);
    expect(prefixes).toEqual([""]);
  });

  it("shows the refusal where the host keeps no track", async () => {
    const { c } = client((call) => (call.query.includes("accounts") ? accountsOf(2) : FORBIDDEN));
    await expect(c.listResources("alert-policy", "acct")).rejects.toThrow("denied");
  });

  it("does not report anything when one account of several refuses", async () => {
    const prefixes = captureUnread();
    const { c } = client((call) => {
      if (call.query.includes("accounts")) return accountsOf(2);
      if (call.variables["accountId"] === 1) return FORBIDDEN;
      return route(2)(call);
    });
    await expect(c.listResources("alert-policy", "acct")).resolves.toHaveLength(1);
    expect(prefixes).toEqual([]);
  });

  it("fails the type on a failure that is not a refusal", async () => {
    const { c } = client((call) => {
      if (call.query.includes("accounts")) return accountsOf(2);
      if (call.variables["accountId"] === 1) {
        return { errors: [{ message: "busy", extensions: { errorClass: "SERVER_ERROR" } }] };
      }
      return route(2)(call);
    });
    await expect(c.listResources("alert-policy", "acct")).rejects.toThrow("busy");
  });

  it("lists nothing, and reports nothing, for a key that sees no accounts", async () => {
    const prefixes = captureUnread();
    const { c } = client(() => accountsOf(0));
    await expect(c.listResources("alert-policy", "acct")).resolves.toEqual([]);
    expect(prefixes).toEqual([]);
  });
});

describe("a credential refused entity search", () => {
  const INVALID = {
    errors: [{ message: "Invalid API key", extensions: { errorClass: "UNAUTHORIZED" } }],
  };

  it("keeps the type's rows quietly", async () => {
    const prefixes = captureUnread();
    const { c } = client(() => FORBIDDEN);
    await expect(c.listResources("host", "acct")).resolves.toEqual([]);
    expect(prefixes).toEqual([""]);
  });

  it("shows the refusal where the host keeps no track", async () => {
    const { c } = client(() => FORBIDDEN);
    await expect(c.listResources("host", "acct")).rejects.toThrow("denied");
  });

  it("still fails on a key New Relic rejects", async () => {
    const prefixes = captureUnread();
    const { c } = client(() => INVALID);
    await expect(c.listResources("host", "acct")).rejects.toThrow("Invalid API key");
    expect(prefixes).toEqual([]);
  });
});
