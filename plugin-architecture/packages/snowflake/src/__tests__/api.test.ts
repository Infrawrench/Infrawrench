import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAccount } from "../account.js";
import type { SnowflakeContext } from "../api.js";
import { SnowflakeError, decodeCell, isNotAuthorized, literal, qualified, runSql } from "../api.js";
import { SnowflakeAuth } from "../auth.js";
import { jsonResponse, resultSet, sqlError } from "./helpers.js";

function ctx(extra: Partial<SnowflakeContext> = {}): SnowflakeContext {
  const account = parseAccount("myorg-myaccount");
  return {
    account,
    auth: new SnowflakeAuth({ kind: "token", token: "t" }, account.jwtAccount, "me"),
    warehouse: "META_WH",
    role: "SYSADMIN",
    ...extra,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("decodeCell", () => {
  it("decodes Snowflake's string encodings by column type", () => {
    expect(decodeCell("42", { name: "n", type: "fixed", scale: 0 })).toBe(42);
    expect(decodeCell("1.50", { name: "n", type: "fixed", scale: 2 })).toBe(1.5);
    expect(decodeCell("123456789012345678901", { name: "n", type: "fixed" })).toBe(
      "123456789012345678901",
    );
    expect(decodeCell("true", { name: "b", type: "boolean" })).toBe(true);
    expect(decodeCell("19723", { name: "d", type: "date" })).toBe("2024-01-01");
    expect(decodeCell("1704067200.000000000", { name: "t", type: "timestamp_ltz" })).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(decodeCell("1704067200.000000000 1440", { name: "t", type: "timestamp_tz" })).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(decodeCell(null, { name: "x", type: "text" })).toBeNull();
  });
});

/** Answers each request from a script, and fails the test on anything it did not expect. */
function scriptedFetch(
  script: Array<{ match: (method: string, url: string) => boolean; res: () => Response }>,
) {
  const calls: Array<{ method: string; url: string }> = [];
  const remaining = [...script];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      calls.push({ method, url });
      const at = remaining.findIndex((step) => step.match(method, url));
      if (at < 0) throw new Error(`unexpected request: ${method} ${url}`);
      return remaining.splice(at, 1)[0]!.res();
    }),
  );
  return calls;
}

const isPost = (method: string) => method === "POST";
const isPoll = (method: string, url: string) => method === "GET" && url.endsWith("/statements/abc");
const isPartition = (method: string, url: string) =>
  method === "GET" && url.endsWith("partition=1");
const accepted = () => jsonResponse(202, { statementHandle: "abc" });
const finished = () =>
  jsonResponse(200, resultSet([{ name: "NAME" }], [["a"]], { statementHandle: "abc" }));
const twoPartitions = () =>
  jsonResponse(
    200,
    resultSet([{ name: "NAME" }], [["a"]], {
      statementHandle: "abc",
      resultSetMetaData: {
        rowType: [{ name: "NAME", type: "text" }],
        partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }],
      },
    }),
  );

/** Runs `read` to the end with the backoff sleeps skipped. */
async function withoutWaiting<T>(read: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const running = read();
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    await vi.runAllTimersAsync();
    await settled;
    return await running;
  } finally {
    vi.useRealTimers();
  }
}

describe("runSql on a transient answer after the submit", () => {
  it.each([429, 503, 504])(
    "polls again after a %d rather than losing the statement",
    async (status) => {
      const calls = scriptedFetch([
        { match: isPost, res: accepted },
        { match: isPoll, res: () => jsonResponse(status, { message: "busy" }) },
        { match: isPoll, res: finished },
      ]);
      const res = await withoutWaiting(() => runSql(ctx(), "SELECT 1"));
      expect(res.rows).toEqual([{ name: "a" }]);
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    },
  );

  it.each([429, 503, 504])("reads a partition again after a %d", async (status) => {
    const calls = scriptedFetch([
      { match: isPost, res: twoPartitions },
      { match: isPartition, res: () => jsonResponse(status, { message: "busy" }) },
      { match: isPartition, res: () => jsonResponse(200, { data: [["b"]] }) },
    ]);
    const res = await withoutWaiting(() => runSql(ctx(), "SELECT 1"));
    expect(res.rows).toEqual([{ name: "a" }, { name: "b" }]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("gives up on a poll after four answers, with the status Snowflake sent", async () => {
    const busy = { match: isPoll, res: () => jsonResponse(503, { message: "busy" }) };
    const calls = scriptedFetch([{ match: isPost, res: accepted }, busy, busy, busy, busy]);
    const err = await withoutWaiting(() => runSql(ctx(), "SELECT 1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnowflakeError);
    expect(err).toMatchObject({ status: 503 });
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(4);
  });

  it("does not repeat a poll that failed for good", async () => {
    const calls = scriptedFetch([
      { match: isPost, res: accepted },
      { match: isPoll, res: () => jsonResponse(422, { code: "000603", message: "SQL failed" }) },
    ]);
    await expect(runSql(ctx(), "SELECT 1")).rejects.toMatchObject({ status: 422 });
    expect(calls).toHaveLength(2);
  }, 30_000);

  it("cancels the statement when the caller aborts while a poll is backing off", async () => {
    const controller = new AbortController();
    const calls = scriptedFetch([
      { match: isPost, res: accepted },
      {
        match: isPoll,
        res: () => {
          controller.abort();
          return jsonResponse(503, { message: "busy" });
        },
      },
      {
        match: (method, url) => isPost(method) && url.endsWith("/statements/abc/cancel"),
        res: () => jsonResponse(200, { statementHandle: "abc" }),
      },
    ]);
    const err = await withoutWaiting(() =>
      runSql(ctx(), "SELECT 1", { signal: controller.signal }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 499 });
    expect(calls.at(-1)?.url).toMatch(/\/statements\/abc\/cancel$/);
  });
});

describe("runSql with everyRow", () => {
  const answer = (res: () => Response) => scriptedFetch([{ match: isPost, res }]);

  it("refuses a 200 that is not a ResultSet, as any other read would take it for no rows", async () => {
    answer(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(runSql(ctx(), "SHOW WAREHOUSES", { everyRow: true })).rejects.toThrow(
      "is not a list",
    );
    answer(() => jsonResponse(200, {}));
    await expect(runSql(ctx(), "SHOW WAREHOUSES", { everyRow: true })).rejects.toThrow(
      "is not a list",
    );
  });

  it("accepts a missing or null data only where the answer says there are no rows", async () => {
    const noRows = { resultSetMetaData: { numRows: 0, rowType: [{ name: "NAME", type: "text" }] } };
    answer(() => jsonResponse(200, noRows));
    expect((await runSql(ctx(), "SHOW PIPES IN ACCOUNT", { everyRow: true })).rows).toEqual([]);
    answer(() => jsonResponse(200, { ...noRows, data: [] }));
    expect((await runSql(ctx(), "SHOW PIPES IN ACCOUNT", { everyRow: true })).rows).toEqual([]);
    answer(() => jsonResponse(200, { data: null }));
    expect((await runSql(ctx(), "SHOW PIPES IN ACCOUNT", { everyRow: true })).rows).toEqual([]);
  });

  it("leaves a statement that does not read a list alone when the 200 has no rows", async () => {
    answer(() => jsonResponse(200, { code: "090001", message: "done" }));
    expect((await runSql(ctx(), "ALTER WAREHOUSE W SUSPEND")).rows).toEqual([]);
  });

  it("throws past maxRows instead of answering with part of the rows, and stops reading", async () => {
    const calls = answer(twoPartitions);
    await expect(
      runSql(ctx(), "SHOW   WAREHOUSES", { everyRow: true, maxRows: 1 }),
    ).rejects.toThrow("Snowflake: SHOW WAREHOUSES has more than Infrawrench reads");
    expect(calls).toHaveLength(1);
    answer(() => jsonResponse(200, resultSet([{ name: "NAME" }], [["a"], ["b"]])));
    await expect(runSql(ctx(), "SELECT 1", { everyRow: true, maxRows: 1 })).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });
});

describe("runSql reading further partitions", () => {
  it("refuses a partition answered without rows", async () => {
    scriptedFetch([
      { match: isPost, res: twoPartitions },
      { match: isPartition, res: () => jsonResponse(200, { message: "wrapped" }) },
    ]);
    await expect(runSql(ctx(), "SELECT 1")).rejects.toThrow("is not a list");
  });

  it("accepts a partition with no rows when the metadata said it has none", async () => {
    scriptedFetch([
      {
        match: isPost,
        res: () =>
          jsonResponse(
            200,
            resultSet([{ name: "NAME" }], [["a"]], {
              statementHandle: "abc",
              resultSetMetaData: {
                rowType: [{ name: "NAME", type: "text" }],
                partitionInfo: [{ rowCount: 1 }, { rowCount: 0 }],
              },
            }),
          ),
      },
      { match: isPartition, res: () => jsonResponse(200, {}) },
    ]);
    expect((await runSql(ctx(), "SELECT 1")).rows).toEqual([{ name: "a" }]);
  });

  it("refuses a result with more partitions and no handle to read them by", async () => {
    scriptedFetch([
      {
        match: isPost,
        res: () =>
          jsonResponse(
            200,
            resultSet([{ name: "NAME" }], [["a"]], {
              statementHandle: undefined,
              resultSetMetaData: {
                rowType: [{ name: "NAME", type: "text" }],
                partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }],
              },
            }),
          ),
      },
    ]);
    await expect(runSql(ctx(), "SELECT 1")).rejects.toThrow("no statement handle");
  });

  it("reads them by the handle it polled, when the finished answer leaves it out", async () => {
    scriptedFetch([
      { match: isPost, res: accepted },
      {
        match: isPoll,
        res: () =>
          jsonResponse(
            200,
            resultSet([{ name: "NAME" }], [["a"]], {
              statementHandle: undefined,
              resultSetMetaData: {
                rowType: [{ name: "NAME", type: "text" }],
                partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }],
              },
            }),
          ),
      },
      { match: isPartition, res: () => jsonResponse(200, { data: [["b"]] }) },
    ]);
    const res = await withoutWaiting(() => runSql(ctx(), "SELECT 1"));
    expect(res.rows).toEqual([{ name: "a" }, { name: "b" }]);
    expect(res.statementHandle).toBe("abc");
  });
});

describe("quoting", () => {
  it("doubles quotes in identifiers and escapes literals", () => {
    expect(qualified('my"db', "s")).toBe('"my""db"."s"');
    expect(literal("it's \\ fine")).toBe("'it''s \\\\ fine'");
  });
});

describe("runSql", () => {
  it("sends context and session parameters, polls a 202 and reads every partition", async () => {
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (init?.method === "POST") {
          return jsonResponse(202, { statementHandle: "abc", statementStatusUrl: "/x" });
        }
        if (url.endsWith("/api/v2/statements/abc")) {
          return jsonResponse(
            200,
            resultSet([{ name: "NAME" }, { name: "N", type: "fixed" }], [["a", "1"]], {
              statementHandle: "abc",
              resultSetMetaData: {
                rowType: [
                  { name: "NAME", type: "text" },
                  { name: "N", type: "fixed", scale: 0 },
                ],
                partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }],
              },
            }),
          );
        }
        if (url.endsWith("partition=1")) return jsonResponse(200, { data: [["b", "2"]] });
        throw new Error(url);
      }),
    );
    const res = await runSql(ctx(), "SELECT 1");
    expect(res.rows).toEqual([
      { name: "a", n: 1 },
      { name: "b", n: 2 },
    ]);
    const post = calls[0]!;
    expect(post.url).toMatch(
      /^https:\/\/myorg-myaccount\.snowflakecomputing\.com\/api\/v2\/statements\?requestId=/,
    );
    expect(post.body).toMatchObject({
      statement: "SELECT 1",
      warehouse: "META_WH",
      role: "SYSADMIN",
      parameters: { timezone: "UTC", query_tag: "infrawrench" },
    });
  }, 30_000);

  it("turns a 422 into a SnowflakeError that knows about authorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sqlError(
          "002003",
          "Object 'SNOWFLAKE.ORGANIZATION_USAGE.X' does not exist or not authorized.",
        ),
      ),
    );
    const err = await runSql(ctx(), "SELECT 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnowflakeError);
    expect(isNotAuthorized(err)).toBe(true);
    expect(isNotAuthorized(new Error("does not exist or not authorized"))).toBe(false);
  });

  it("keeps column case for the SQL editor and stops at maxRows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, resultSet([{ name: "Id" }], [["1"], ["2"], ["3"]]))),
    );
    const res = await runSql(ctx(), "SELECT 1", { keepColumnCase: true, maxRows: 2 });
    expect(res.rows).toEqual([{ Id: "1" }, { Id: "2" }]);
    expect(res.truncated).toBe(true);
  });
});
