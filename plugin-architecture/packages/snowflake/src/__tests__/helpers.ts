import { vi } from "vitest";

export interface Col {
  name: string;
  type?: string;
  scale?: number;
}

/** A SQL API 200 ResultSet body. Values are given as Snowflake sends them: strings or null. */
export function resultSet(
  columns: Col[],
  data: Array<Array<string | null>>,
  extra: Record<string, unknown> = {},
) {
  return {
    code: "090001",
    statementHandle: "h-1",
    resultSetMetaData: {
      numRows: data.length,
      format: "jsonv2",
      rowType: columns.map((c) => ({ name: c.name, type: c.type ?? "text", scale: c.scale ?? 0 })),
      partitionInfo: [{ rowCount: data.length }],
    },
    data,
    ...extra,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type Handler = (statement: string, body: Record<string, unknown>) => Response | undefined;

/**
 * Replaces global fetch. `handler` sees each POSTed statement; returning
 * undefined fails the test loudly. Returns the mock and the statements seen.
 */
export function mockSnowflake(handler: Handler) {
  const statements: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" && u.includes("/api/v2/statements")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const statement = String(body["statement"]).replace(/\s+/g, " ").trim();
      statements.push(statement);
      bodies.push(body);
      const res = handler(statement, body);
      if (!res) throw new Error(`unexpected statement: ${statement}`);
      return res;
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, statements, bodies };
}

export const sqlError = (code: string, message: string) =>
  jsonResponse(422, { code, message, sqlState: "02000" });

export const CREDS = {
  account: "myorg-myaccount",
  user: "INFRAWRENCH",
  credential: "pat-secret-token",
};
