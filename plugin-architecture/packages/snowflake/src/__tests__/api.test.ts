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
  });

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
