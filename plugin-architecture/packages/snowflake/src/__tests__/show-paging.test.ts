import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnowflakeClient } from "../client.js";
import { TYPE } from "../resource-types.js";
import { CREDS, jsonResponse, mockSnowflake, resultSet, sqlError } from "./helpers.js";

// These tests read many pages or wait on timers, which runs far slower on CI than locally.
vi.setConfig({ testTimeout: 60_000 });

const UNREAD = Symbol.for("infrawrench.unreadListPart");

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, UNREAD);
});

/** What SHOW answers without LIMIT over ten thousand rows. */
const tooMany = () =>
  sqlError(
    "090153",
    "The result set size exceeded the max number of rows(10000) supported for SHOW statements. Use LIMIT option to limit result set to a smaller number.",
  );

const rows = (names: string[], database = "DB", schema = "PUBLIC") =>
  jsonResponse(
    200,
    resultSet(
      [{ name: "name" }, { name: "database_name" }, { name: "schema_name" }],
      names.map((n) => [n, database, schema]),
    ),
  );

const pad = (i: number) => String(i).padStart(5, "0");
const named = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `${prefix}${pad(from + i)}`);

/**
 * A scope of `total` names, served the way SHOW pages them: `LIMIT n` from the start,
 * `LIMIT n FROM 'x'` from the first name at or after x, inclusive or not.
 */
function pagedScope(prefix: string, total: number, inclusive: boolean) {
  const all = named(prefix, 0, total);
  return (limitAndFrom: string) => {
    const m = /^LIMIT 10000(?: FROM '(.*)')?$/.exec(limitAndFrom);
    if (!m) return undefined;
    const from = m[1];
    let start = 0;
    if (from !== undefined) {
      start = all.findIndex((n) => (inclusive ? n >= from : n > from));
      if (start < 0) start = all.length;
    }
    return all.slice(start, start + 10_000);
  };
}

describe("SHOW lists past 10,000 records", () => {
  it.each([true, false])(
    "pages SHOW DATABASES with LIMIT ... FROM (FROM inclusive: %s)",
    async (inclusive) => {
      const scope = pagedScope("D_", 12_500, inclusive);
      const { statements } = mockSnowflake((s) => {
        if (s === "SHOW DATABASES") return tooMany();
        const page = s.startsWith("SHOW DATABASES ") ? scope(s.slice(15)) : undefined;
        return page ? rows(page) : undefined;
      });
      const list = await hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.database, "acc");
      expect(list).toHaveLength(12_500);
      expect(new Set(list.map((r) => r.id)).size).toBe(12_500);
      expect(statements).toEqual([
        "SHOW DATABASES",
        "SHOW DATABASES LIMIT 10000",
        "SHOW DATABASES LIMIT 10000 FROM 'D_09998'",
        "SHOW DATABASES LIMIT 10000 FROM 'D_12498'",
      ]);
    },
  );

  it("pages SHOW USERS when the unpaged answer stops at 10,000", async () => {
    const scope = pagedScope("U_", 10_003, true);
    mockSnowflake((s) => {
      if (s === "SHOW USERS") return rows(named("U_", 0, 10_000));
      const page = s.startsWith("SHOW USERS ") ? scope(s.slice(11)) : undefined;
      return page ? rows(page) : undefined;
    });
    const list = await hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.user, "acc");
    expect(list).toHaveLength(10_003);
  });

  it("throws on a page that does not carry on from the last row read", async () => {
    mockSnowflake((s) => {
      if (s === "SHOW ROLES") return tooMany();
      if (s === "SHOW ROLES LIMIT 10000") return rows(named("R_", 0, 10_000));
      // Starts somewhere else: rows between could be missing.
      if (s.startsWith("SHOW ROLES LIMIT 10000 FROM")) return rows(named("R_", 10_500, 11_000));
      return undefined;
    });
    await expect(
      hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.role, "acc"),
    ).rejects.toThrow('does not carry on from "R_09999"');
  });

  it("throws when paging reads no more than the unpaged answer said there are", async () => {
    mockSnowflake((s) => {
      if (s === "SHOW ROLES") return tooMany();
      if (s === "SHOW ROLES LIMIT 10000") return rows(named("R_", 0, 9_000));
      if (s === "SHOW ROLES LIMIT 10000 FROM 'R_08998'") return rows(named("R_", 8_998, 9_000));
      return undefined;
    });
    await expect(
      hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.role, "acc"),
    ).rejects.toThrow("Refusing to read that as the whole list");
  });

  it("passes on a failure that is not SHOW's 10,000 limit", async () => {
    const { statements } = mockSnowflake(() => jsonResponse(500, { message: "internal error" }));
    await expect(
      hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.database, "acc"),
    ).rejects.toMatchObject({ status: 500 });
    expect(statements.every((s) => s === "SHOW DATABASES")).toBe(true);
  });

  it("reads tasks one database, then one schema, at a time when the account has too many", async () => {
    const big = pagedScope("T_", 10_500, true);
    const { statements } = mockSnowflake((s) => {
      if (s === "SHOW TASKS IN ACCOUNT") return tooMany();
      if (s === "SHOW DATABASES") return rows(["A", "B"]);
      if (s === 'SHOW TASKS IN DATABASE "A"') return rows(["T1", "T2", "T3"], "A");
      if (s === 'SHOW TASKS IN DATABASE "B"') return tooMany();
      if (s === 'SHOW SCHEMAS IN DATABASE "B"') {
        return rows(["INFORMATION_SCHEMA", "S1", "S2"], "B");
      }
      if (s === 'SHOW TASKS IN SCHEMA "B"."S1"') return rows(["X", "Y"], "B", "S1");
      if (s === 'SHOW TASKS IN SCHEMA "B"."S2"') return tooMany();
      const prefix = 'SHOW TASKS IN SCHEMA "B"."S2" ';
      const page = s.startsWith(prefix) ? big(s.slice(prefix.length)) : undefined;
      return page ? rows(page, "B", "S2") : undefined;
    });
    const list = await hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.task, "acc");
    expect(list).toHaveLength(3 + 2 + 10_500);
    expect(new Set(list.map((r) => r.id)).size).toBe(list.length);
    expect(list.map((r) => r.id)).toContain("acc:snowflake-task:B.S2.T_10499");
    expect(statements).not.toContain('SHOW TASKS IN SCHEMA "B"."INFORMATION_SCHEMA"');
  });

  it("keeps the rows of a database the role may no longer read, and lists the rest", async () => {
    const noted: Array<{ idPrefixes?: readonly string[] }> = [];
    Reflect.set(globalThis, UNREAD, (part: { idPrefixes?: readonly string[] }) => noted.push(part));
    mockSnowflake((s) => {
      if (s === "SHOW DYNAMIC TABLES IN ACCOUNT") return tooMany();
      if (s === "SHOW DATABASES") return rows(["A", "B"]);
      if (s === 'SHOW DYNAMIC TABLES IN DATABASE "A"') {
        return rows(named("DT_", 0, 9_999), "A", "S");
      }
      if (s === 'SHOW DYNAMIC TABLES IN DATABASE "B"') {
        return sqlError("002003", "Database 'B' does not exist or not authorized.");
      }
      return undefined;
    });
    const list = await hostClient(new SnowflakeClient(CREDS)).listResources(
      TYPE.dynamicTable,
      "acc",
    );
    expect(list).toHaveLength(9_999);
    expect(noted).toEqual([{ idPrefixes: ["acc:snowflake-dynamic-table:B."] }]);
  });

  it("shows a database the role may no longer read where the host keeps no track", async () => {
    mockSnowflake((s) => {
      if (s === "SHOW DYNAMIC TABLES IN ACCOUNT") return tooMany();
      if (s === "SHOW DATABASES") return rows(["A", "B"]);
      if (s === 'SHOW DYNAMIC TABLES IN DATABASE "A"') {
        return rows(named("DT_", 0, 9_999), "A", "S");
      }
      if (s === 'SHOW DYNAMIC TABLES IN DATABASE "B"') {
        return sqlError("002003", "Database 'B' does not exist or not authorized.");
      }
      return undefined;
    });
    await expect(
      hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.dynamicTable, "acc"),
    ).rejects.toThrow("not authorized");
  });

  it("reads every database where the host keeps no track of the rest", async () => {
    const dbs = named("DB_", 0, 500);
    mockSnowflake((s) => {
      if (s === "SHOW SCHEMAS IN ACCOUNT") return tooMany();
      if (s === "SHOW DATABASES") return rows(dbs);
      const m = /^SHOW SCHEMAS IN DATABASE "(DB_\d+)"$/.exec(s);
      return m ? rows(named("S_", 0, 30), m[1]) : undefined;
    });
    const list = await hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.schema, "acc");
    expect(list).toHaveLength(500 * 30);
  });

  it("still throws at 10,000 pipes, which SHOW PIPES cannot page", async () => {
    mockSnowflake((s) =>
      s === "SHOW PIPES IN ACCOUNT" ? rows(named("P_", 0, 10_000)) : undefined,
    );
    await expect(
      hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.pipe, "acc"),
    ).rejects.toThrow("has more than Infrawrench reads");
  });

  it("reads what fits in one poll and names the databases past it", async () => {
    const noted: Array<{ idPrefixes?: readonly string[] }> = [];
    Reflect.set(globalThis, UNREAD, (part: { idPrefixes?: readonly string[] }) => noted.push(part));
    const dbs = named("DB_", 0, 500);
    const { statements } = mockSnowflake((s) => {
      if (s === "SHOW SCHEMAS IN ACCOUNT") return tooMany();
      if (s === "SHOW DATABASES") return rows(dbs);
      const m = /^SHOW SCHEMAS IN DATABASE "(DB_\d+)"$/.exec(s);
      return m ? rows(named("S_", 0, 30), m[1]) : undefined;
    });
    const list = await hostClient(new SnowflakeClient(CREDS)).listResources(TYPE.schema, "acc");
    const unread = noted.flatMap((n) => n.idPrefixes ?? []);
    expect(statements.length).toBeLessThanOrEqual(400);
    expect(list.length + unread.length * 30).toBe(500 * 30);
    const readDbs = new Set(list.map((r) => r.fields["database"]));
    for (const prefix of unread) {
      const db = prefix.replace("acc:snowflake-schema:", "").replace(/\.$/, "");
      expect(readDbs.has(db)).toBe(false);
    }
  });
});
