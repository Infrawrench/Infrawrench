import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { instancePricingTools } = await import("../instance-pricing");

const tools = instancePricingTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "mcp" as const };

/** What the warehouse answers, as JSONCompactEachRowWithNamesAndTypes. */
function warehouseRows(names: string[], types: string[], rows: unknown[][]): Response {
  const body = [names, types, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n";
  return new Response(body, { status: 200 });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("PRICING_WAREHOUSE_READ_TOKEN", "read-only-test-token");
  vi.stubEnv("PRICING_WAREHOUSE_URL", "https://warehouse.test/");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    warehouseRows(
      ["instance_type", "effective_hourly_usd"],
      ["String", "Float64"],
      [["t4g.nano", 0.0042]],
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function text(result: { content: { text: string }[]; isError?: boolean }) {
  return { text: result.content[0]?.text ?? "", isError: result.isError ?? false };
}

describe("instance pricing tools", () => {
  it("are read-only and ungated, matching the HTTP routes", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "get_instance_pricing_schema",
      "query_instance_pricing",
    ]);
    for (const t of tools) {
      expect(t.risk).toBe("read");
      expect(t.permission).toBeNull();
    }
  });

  it("describes the tables even when freshness cannot be read", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const result = await tool("get_instance_pricing_schema").handler({}, auth);
    const body = JSON.parse(text(result).text) as {
      tables: { name: string }[];
      notes: string[];
      sources: unknown;
    };
    expect(text(result).isError).toBe(false);
    expect(body.tables.map((t) => t.name)).toContain("prices");
    expect(body.notes.length).toBeGreaterThan(3);
    expect(body.sources).toBeNull();
  });

  it("runs one statement and returns the rows", async () => {
    const result = await tool("query_instance_pricing").handler(
      { sql: "SELECT instance_type FROM prices LIMIT 1" },
      auth,
    );
    const body = JSON.parse(text(result).text) as {
      rows: unknown[][];
      truncated: boolean;
    };
    expect(text(result).isError).toBe(false);
    expect(body.rows).toEqual([["t4g.nano", 0.0042]]);
    expect(body.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a write without asking the warehouse", async () => {
    const result = await tool("query_instance_pricing").handler({ sql: "DROP TABLE prices" }, auth);
    expect(text(result).isError).toBe(true);
    expect(text(result).text).toMatch(/SELECT/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes ClickHouse's own error back", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Code: 47. DB::Exception: Unknown identifier `nope`. (UNKNOWN_IDENTIFIER)", {
        status: 500,
      }),
    );
    const result = await tool("query_instance_pricing").handler({ sql: "SELECT nope" }, auth);
    expect(text(result).isError).toBe(true);
    expect(text(result).text).toContain("Unknown identifier `nope`");
  });

  it("says the warehouse is down rather than blaming the query", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<!DOCTYPE html><title>Worker threw exception</title>", { status: 500 }),
    );
    const result = await tool("query_instance_pricing").handler({ sql: "SELECT 1" }, auth);
    expect(text(result).isError).toBe(true);
    expect(text(result).text).toMatch(/unavailable/i);
  });

  it("says so when this deployment has no warehouse token", async () => {
    vi.stubEnv("PRICING_WAREHOUSE_READ_TOKEN", "");
    const result = await tool("query_instance_pricing").handler({ sql: "SELECT 1" }, auth);
    expect(text(result).isError).toBe(true);
    expect(text(result).text).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
