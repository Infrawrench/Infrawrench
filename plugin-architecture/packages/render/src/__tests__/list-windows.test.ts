import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { installFetch, route, state, type Call } from "./helpers.js";

const ACCOUNT = "acct";
const TRUNCATED = "has more than Infrawrench reads";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const BASE = Date.UTC(2024, 0, 1);
const MINUTE = 60_000;

const client = () => hostClient(new RenderClient({ apiKey: "rnd_key" }, RESOURCE_TYPES));

interface Row {
  id: string;
  createdAt: string;
}

/**
 * A route that honours `createdAfter`, `createdBefore` and `limit` and hands back no
 * cursor, in an order that is neither oldest nor newest first.
 */
function windowed<T extends Row>(all: T[], opts: { inclusive: boolean }) {
  return (call: Call) => {
    const after = call.query.get("createdAfter");
    const before = call.query.get("createdBefore");
    const limit = Number(call.query.get("limit") ?? "20");
    const inWindow = all.filter((row) => {
      const at = Date.parse(row.createdAt);
      if (after && (opts.inclusive ? at < Date.parse(after) : at <= Date.parse(after)))
        return false;
      if (before && (opts.inclusive ? at > Date.parse(before) : at >= Date.parse(before)))
        return false;
      return true;
    });
    const shuffled = [...inWindow].sort((a, b) => (hash(a.id) < hash(b.id) ? -1 : 1));
    return shuffled.slice(0, limit);
  };
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_003, 7);

const groups = (count: number, spacingMs = 37 * MINUTE) =>
  Array.from({ length: count }, (_, i) => ({
    id: `evg-${i}`,
    name: `group-${i}`,
    ownerId: "tea-1",
    serviceLinks: [],
    createdAt: new Date(BASE + i * spacingMs).toISOString(),
    updatedAt: new Date(BASE + i * spacingMs).toISOString(),
  }));

beforeEach(() => installFetch());
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

describe("environment groups with no cursor", () => {
  it.each([true, false])(
    "reads every group by creation window (bounds inclusive: %s)",
    async (inclusive) => {
      const all = groups(250);
      // Three created in the same millisecond, wherever a window is cut.
      for (const i of [120, 121, 122]) all[i]!.createdAt = all[119]!.createdAt;
      route("GET", "/env-groups", windowed(all, { inclusive }));
      const rows = await client().listResources("env-group", ACCOUNT);
      expect(new Set(rows.map((r) => r.externalId)).size).toBe(250);
      expect(rows).toHaveLength(250);
      expect(state.calls.length).toBeLessThan(120);
    },
  );

  it("reads exactly 100 groups whole", async () => {
    route("GET", "/env-groups", windowed(groups(100), { inclusive: false }));
    expect(await client().listResources("env-group", ACCOUNT)).toHaveLength(100);
  });

  it("keeps narrowing to the workspace while it reads by window", async () => {
    route("GET", "/env-groups", windowed(groups(150), { inclusive: false }));
    const c = hostClient(
      new RenderClient({ apiKey: "rnd_key", workspaceId: "tea-1" }, RESOURCE_TYPES),
    );
    expect(await c.listResources("env-group", ACCOUNT)).toHaveLength(150);
    for (const call of state.calls) expect(call.query.getAll("ownerId")).toEqual(["tea-1"]);
  });

  it("refuses when Render answers a window with groups outside it", async () => {
    const all = groups(150);
    route("GET", "/env-groups", (call: Call) => all.slice(0, Number(call.query.get("limit"))));
    await expect(client().listResources("env-group", ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(state.calls.length).toBeLessThan(5);
  });

  it("refuses more than 100 groups created in one millisecond", async () => {
    const all = groups(150, 0);
    route("GET", "/env-groups", windowed(all, { inclusive: true }));
    await expect(client().listResources("env-group", ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(state.calls.length).toBeLessThan(100);
  });
});

interface Dated {
  id: string;
  createdAt: string;
  status: string;
  startCommand: string;
}

/** `count` rows, one an hour back from now, oldest first, each in a cursor wrapper. */
function history(key: string, count: number): Array<Record<string, unknown>> {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const row: Dated = {
      id: `r-${i}`,
      createdAt: new Date(now - (count - i) * 60 * MINUTE).toISOString(),
      status: "succeeded",
      startCommand: "x",
    };
    return { [key]: row, cursor: `c${i}` };
  });
}

function createdOf(row: Record<string, unknown>, key: string): number {
  const inner = row[key];
  if (typeof inner !== "object" || inner === null || !("createdAt" in inner)) return NaN;
  return typeof inner.createdAt === "string" ? Date.parse(inner.createdAt) : NaN;
}

describe("recent deploys and jobs in either order", () => {
  it.each([
    ["deploy", "deploys", 10],
    ["job", "jobs", 20],
  ])("keeps the newest %s rows when Render answers oldest first", async (typeId, segment, n) => {
    const rows = history(typeId, 400);
    route("GET", "/services", [
      { service: { id: "srv-web", name: "api", type: "web_service" }, cursor: "x" },
    ]);
    route("GET", `/services/srv-web/${segment}`, (call: Call) => {
      const after = call.query.get("createdAfter");
      const kept = after ? rows.filter((r) => createdOf(r, typeId) > Date.parse(after)) : rows;
      return kept.slice(0, Number(call.query.get("limit")));
    });
    const out = await client().listResources(typeId, ACCOUNT);
    expect(out.map((r) => r.externalId).sort()).toEqual(
      rows
        .slice(-n)
        .map((_, i) => `srv-web/r-${400 - n + i}`)
        .sort(),
    );
    expect(state.calls.filter((c) => c.path.endsWith(segment)).length).toBeLessThan(15);
  });

  it("reads one page when Render answers newest first", async () => {
    const rows = history("deploy", 50).reverse();
    route("GET", "/services", [
      { service: { id: "srv-web", name: "api", type: "web_service" }, cursor: "x" },
    ]);
    route("GET", "/services/srv-web/deploys", (call: Call) =>
      rows.slice(0, Number(call.query.get("limit"))),
    );
    const out = await client().listResources("deploy", ACCOUNT);
    expect(out.map((r) => r.externalId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `srv-web/r-${49 - i}`),
    );
    expect(state.calls.filter((c) => c.path.endsWith("deploys"))).toHaveLength(1);
  });
});
