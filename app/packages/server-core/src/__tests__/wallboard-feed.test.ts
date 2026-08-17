import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the wall says when a source cannot be read.
 *
 * This is the behaviour the whole feature turns on: a source that throws is
 * named on the screen and the wall goes amber, because a wallboard showing
 * green because a query failed is worse than a blank one. It is also the
 * behaviour that is easy to trip over — the wallboard once shipped reading a
 * `query_monitors` table whose migration had not landed, and the guard duly
 * named a source no org had yet and held every screen amber. Hence a test that
 * pins both directions: a failing source is named, and every source the module
 * claims to read is one that exists.
 *
 * The query monitors source carries the second rule this module keeps getting
 * asked about: a monitor that could not run is not fine, and a monitor that has
 * not run yet is not broken.
 *
 * The database is faked rather than run. What is under test is the mapping from
 * rows and errors to what reaches the screen.
 */

const NOW = Date.parse("2026-08-18T09:00:00.000Z");

/** Rows each read resolves to, keyed by the table the query selects from. */
const rows = new Map<string, unknown[]>();
/** Tables whose read should throw, standing in for a source that is down. */
const throwing = new Set<string>();

function tableName(table: unknown): string {
  // Drizzle hangs the SQL name off a symbol; the description is stable and is
  // the only identifier a fake can key on without importing every table.
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    s.description?.includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "";
}

/** A chainable stand-in for a drizzle select builder. */
function builder(name: string): unknown {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[method] = (arg: unknown) => (method === "from" ? builder(tableName(arg)) : chain);
  }
  chain["then"] = (resolve: (value: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    throwing.has(name)
      ? Promise.resolve().then(() => reject(new Error(`${name} is unavailable`)))
      : Promise.resolve().then(() => resolve(rows.get(name) ?? []));
  return chain;
}

vi.mock("../db/client", () => ({
  db: {
    select: () => builder(""),
    execute: () => {
      throw new Error("the wallboard reads no table that needs raw SQL");
    },
  },
}));

const { getWallboard } = await import("../wallboard/feed");

describe("getWallboard", () => {
  beforeEach(() => {
    rows.clear();
    throwing.clear();
  });

  it("reads green with nothing wrong, and names four tiles", async () => {
    const wall = await getWallboard("org_1", { now: NOW });

    expect(wall.status).toBe("ok");
    expect(wall.failedSources).toEqual([]);
    expect(wall.tiles.map((tile) => tile.id)).toEqual([
      "incidents",
      "probes",
      "monitors",
      "accounts",
    ]);
    expect(wall.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it("names a source that could not be read and refuses to read ok", async () => {
    throwing.add("synthetic_probes");

    const wall = await getWallboard("org_1", { now: NOW });

    expect(wall.failedSources).toEqual(["probes"]);
    expect(wall.status).toBe("degraded");
    expect(wall.tiles.find((tile) => tile.id === "probes")).toMatchObject({
      detail: "could not be read",
      status: "degraded",
    });
  });

  it("costs one source its own tile and leaves the others reading true", async () => {
    throwing.add("incidents");
    rows.set("synthetic_probes", [
      {
        id: "probe_1",
        name: "Checkout",
        status: "down",
        lastError: "502 from the edge",
        lastStateChangeAt: new Date(NOW - 300_000),
      },
    ]);

    const wall = await getWallboard("org_1", { now: NOW });

    expect(wall.failedSources).toEqual(["incidents"]);
    // A probe down is `down` whatever else failed — that is the state that
    // means customers are affected right now.
    expect(wall.status).toBe("down");
    expect(wall.failures).toEqual([
      {
        id: "probe:probe_1",
        label: "Checkout",
        detail: "502 from the edge",
        since: new Date(NOW - 300_000).toISOString(),
      },
    ]);
    expect(wall.tiles.find((tile) => tile.id === "probes")?.value).toBe("0/1");
  });

  it("puts a breaching monitor on the wall with what it saw", async () => {
    rows.set("query_monitors", [
      {
        id: "qm_1",
        name: "Orders stuck",
        state: "breaching",
        mode: "rowCount",
        operator: "gt",
        threshold: 1000,
        lastValue: 4213,
        lastError: null,
        lastRunAt: new Date(NOW - 60_000),
      },
    ]);

    const wall = await getWallboard("org_1", { now: NOW });

    expect(wall.status).toBe("degraded");
    expect(wall.failures).toEqual([
      { id: "monitor:qm_1", label: "Orders stuck", detail: "4213 > 1000", since: null },
    ]);
    expect(wall.tiles.find((tile) => tile.id === "monitors")).toMatchObject({
      value: "1",
      detail: null,
      status: "degraded",
    });
  });

  it("counts a monitor that could not run rather than reading it as fine", async () => {
    rows.set("query_monitors", [
      {
        id: "qm_1",
        name: "Dead letters",
        state: "unknown",
        mode: "scalar",
        operator: "gt",
        threshold: 0,
        lastValue: null,
        lastError: 'relation "dead_letters" does not exist',
        lastRunAt: new Date(NOW - 60_000),
      },
    ]);

    const wall = await getWallboard("org_1", { now: NOW });

    // Not breaching — the number stays 0 — but the wall is not green either.
    expect(wall.tiles.find((tile) => tile.id === "monitors")).toMatchObject({
      value: "0",
      detail: "1 not reporting",
      status: "degraded",
    });
    expect(wall.failures).toEqual([
      {
        id: "monitor:qm_1",
        label: "Dead letters",
        detail: 'relation "dead_letters" does not exist',
        since: null,
      },
    ]);
    expect(wall.status).toBe("degraded");
  });

  it("leaves a monitor that has never run off the wall entirely", async () => {
    rows.set("query_monitors", [
      {
        id: "qm_1",
        name: "Fresh",
        state: "unknown",
        mode: "scalar",
        operator: "gt",
        threshold: 0,
        lastValue: null,
        lastError: null,
        lastRunAt: null,
      },
    ]);

    const wall = await getWallboard("org_1", { now: NOW });

    expect(wall.status).toBe("ok");
    expect(wall.failures).toEqual([]);
    expect(wall.tiles.find((tile) => tile.id === "monitors")).toMatchObject({
      value: "0",
      detail: null,
      status: "ok",
    });
  });

  it("does not count a probe that has never run as down", async () => {
    rows.set("synthetic_probes", [
      { id: "probe_1", name: "Fresh", status: "unknown", lastError: null, lastStateChangeAt: null },
    ]);

    const wall = await getWallboard("org_1", { now: NOW });

    expect(wall.status).toBe("ok");
    expect(wall.failures).toEqual([]);
    expect(wall.tiles.find((tile) => tile.id === "probes")?.value).toBe("1/1");
  });
});
