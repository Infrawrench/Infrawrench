import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  authenticateApiRequest: (...a: unknown[]) => mockAuth(...a),
}));

const { awsPricingRoutes } = await import("@/api/routes/aws-pricing");

/** What the warehouse answers, as JSONCompactEachRowWithNamesAndTypes. */
function warehouseRows(names: string[], types: string[], rows: unknown[][]): Response {
  const body = [names, types, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n";
  return new Response(body, { status: 200 });
}

const fetchMock = vi.fn<typeof fetch>();
const sent: { url: string; body: string; auth: string | null }[] = [];

beforeEach(() => {
  mockAuth.mockResolvedValue({ userId: "u", organizationId: "o" });
  vi.stubEnv("PRICING_WAREHOUSE_READ_TOKEN", "read-only-test-token");
  vi.stubEnv("PRICING_WAREHOUSE_URL", "https://warehouse.test/");
  sent.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    sent.push({
      url: String(input),
      body: String(init?.body),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return warehouseRows(
      ["instance_type", "vcpu", "effective_hourly_usd", "rows"],
      ["String", "Nullable(Float64)", "Float64", "UInt64"],
      [
        ["t4g.nano", 2, 0.0042, "18446744073709551"],
        ["t4g.micro", 2, 0.0084, "3"],
      ],
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const post = (body: unknown) =>
  awsPricingRoutes.request("/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/v1/aws-pricing/query", () => {
  it("runs the statement with the read-only token and returns typed rows", async () => {
    const res = await post({ sql: "SELECT instance_type FROM prices LIMIT 2;" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      columns: [
        { name: "instance_type", type: "String" },
        { name: "vcpu", type: "Nullable(Float64)" },
        { name: "effective_hourly_usd", type: "Float64" },
        { name: "rows", type: "UInt64" },
      ],
      // UInt64 arrives quoted from ClickHouse and leaves as a number.
      rows: [
        ["t4g.nano", 2, 0.0042, 18446744073709551],
        ["t4g.micro", 2, 0.0084, 3],
      ],
      truncated: false,
    });
    expect(sent[0]).toMatchObject({
      body: "SELECT instance_type FROM prices LIMIT 2",
      auth: "Bearer read-only-test-token",
    });
    expect(sent[0]!.url).toContain("https://warehouse.test/");
  });

  it("stops at maxRows and says so", async () => {
    const body = (await (await post({ sql: "SELECT 1", maxRows: 1 })).json()) as {
      rows: unknown[];
      truncated: boolean;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  it("refuses writes, several statements and bad limits without asking the warehouse", async () => {
    for (const [request, message] of [
      [{ sql: "DROP TABLE prices" }, /read-only|SELECT/i],
      [{ sql: "SELECT 1; DROP TABLE prices" }, /one statement/],
      [{ sql: "SELECT 1", maxRows: 0 }, /maxRows/],
      [{ sql: "SELECT 1", maxRows: 1_000_000 }, /maxRows/],
      [{}, /sql/],
    ] as const) {
      const res = await post(request);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes ClickHouse's own error back as a 400", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        "Code: 47. DB::Exception: Unknown identifier `nope`. (UNKNOWN_IDENTIFIER) (version 26.11.1.1)",
        {
          status: 500,
        },
      ),
    );
    const res = await post({ sql: "SELECT nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Code: 47. DB::Exception: Unknown identifier `nope`. (UNKNOWN_IDENTIFIER)",
    );
  });

  it("answers 502 when the warehouse itself is down, not a 400", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<!DOCTYPE html><title>Worker threw exception</title>", { status: 500 }),
    );
    expect((await post({ sql: "SELECT 1" })).status).toBe(502);
  });

  it("answers 503 when this deployment has no warehouse token", async () => {
    vi.stubEnv("PRICING_WAREHOUSE_READ_TOKEN", "");
    expect((await post({ sql: "SELECT 1" })).status).toBe(503);
  });

  it("needs a credential", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await post({ sql: "SELECT 1" })).status).toBe(401);
  });
});

describe("GET /api/v1/aws-pricing/schema", () => {
  it("lists every table with its columns, the notes, and each source's freshness", async () => {
    fetchMock.mockResolvedValueOnce(
      warehouseRows(
        ["source", "version", "priceListTo", "syncedAt", "priceRows"],
        ["String", "String", "Nullable(DateTime)", "DateTime", "UInt64"],
        [["ec2", "1793314931", "2026-10-29 17:56:34", "2026-11-01 16:50:00", "6343195"]],
      ),
    );
    const res = await awsPricingRoutes.request("/schema");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tables: { name: string; columns: { name: string }[] }[];
      notes: string[];
      sources: unknown[];
    };
    expect(body.tables.map((t) => t.name)).toEqual([
      "prices",
      "instance_types",
      "attribute_changes",
      "regions",
      "sync_state",
    ]);
    expect(body.tables[0]!.columns.map((c) => c.name)).toContain("effective_hourly_usd");
    expect(body.notes.length).toBeGreaterThan(3);
    expect(body.sources).toEqual([
      {
        source: "ec2",
        version: "1793314931",
        priceListTo: "2026-10-29 17:56:34",
        syncedAt: "2026-11-01 16:50:00",
        priceRows: 6343195,
      },
    ]);
  });

  it("still describes the tables when the warehouse cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const body = (await (await awsPricingRoutes.request("/schema")).json()) as {
      tables: unknown[];
      sources: unknown;
    };
    expect(body.tables).toHaveLength(5);
    expect(body.sources).toBeNull();
  });
});

describe("the docs page", () => {
  it("describes every table, column and note the schema has", async () => {
    const { readFileSync } = await import("node:fs");
    const { TABLES, SCHEMA_NOTES } =
      await import("@infrawrench/server-core/aws-pricing-warehouse/schema");
    const page = readFileSync(
      new URL(
        "../../../../../website/src/content/docs/team-and-billing/aws-pricing-api.md",
        import.meta.url,
      ),
      "utf8",
    );
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const missing: string[] = [];
    for (const table of TABLES) {
      if (!page.includes(`### \`${table.name}\``)) missing.push(`table ${table.name}`);
      for (const col of table.columns) {
        const row = new RegExp(
          `\\|\\s*\`${escape(col.name)}\`\\s*\\|\\s*\`${escape(col.type)}\`\\s*\\|`,
        );
        if (!row.test(page)) missing.push(`${table.name}.${col.name} ${col.type}`);
      }
    }
    for (const note of SCHEMA_NOTES)
      if (!page.includes(note)) missing.push(`note: ${note.slice(0, 40)}`);
    // Add (or correct) these in the page's Schema section; the table and its
    // column comments are server-core's aws-pricing-warehouse/schema.ts.
    expect(missing).toEqual([]);
  });
});
