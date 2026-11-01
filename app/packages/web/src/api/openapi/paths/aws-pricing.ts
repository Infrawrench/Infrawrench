import { MAX_QUERY_ROWS as MAX_ROWS } from "@infrawrench/server-core/aws-pricing-warehouse/query";
import { SCHEMA_NOTES, TABLES } from "@infrawrench/server-core/aws-pricing-warehouse/schema";
import { z } from "../zod";
import { strict, ErrorResponses, ErrorResponse } from "../common";
import type { BuildContext } from "../context";

/**
 * `/api/v1/aws-pricing`: read-only SQL over the AWS pricing warehouse (see
 * `routes/aws-pricing.ts`). The table list in the descriptions is generated
 * from the warehouse schema, so the spec cannot drift from the tables.
 */
export function registerAwsPricingPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]).openapi("AwsPricingCell", {
    description:
      "One value. Numbers (including ClickHouse's 64-bit integers and decimals) are JSON " +
      "numbers; DateTime is `YYYY-MM-DD hh:mm:ss` in UTC; arrays and maps are JSON text.",
  });

  const Column = strict({
    name: z.string().openapi({ example: "instance_type" }),
    type: z.string().openapi({ example: "String" }).describe("The ClickHouse type."),
  }).openapi("AwsPricingResultColumn");

  const QueryRequest = strict({
    sql: z
      .string()
      .min(1)
      .max(20_000)
      .describe(
        "One read-only statement: SELECT or WITH (also DESCRIBE, SHOW, EXPLAIN). No FORMAT or " +
          "SETTINGS clause, no trailing second statement.",
      )
      .openapi({
        example:
          "SELECT instance_type, vcpu, memory_gib, effective_hourly_usd FROM prices WHERE platform = 'ec2' AND current AND pricing = 'on_demand' AND region = 'us-east-1' AND operating_system = 'Linux' AND tenancy = 'Shared' AND pre_installed_sw = 'NA' AND capacity_status = 'Used' AND architecture = 'arm64' ORDER BY effective_hourly_usd LIMIT 5",
      }),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROWS)
      .optional()
      .describe(`Rows to return at most. Default 1,000; at most ${MAX_ROWS.toLocaleString("en")}.`),
  }).openapi("AwsPricingQueryRequest");

  const QueryResult = strict({
    columns: z.array(Column),
    rows: z.array(z.array(Cell)).describe("Each row's values, in `columns` order."),
    truncated: z
      .boolean()
      .describe("More rows matched than `maxRows`; add a LIMIT or aggregate to see them all."),
    elapsedMs: z.number().int(),
  }).openapi("AwsPricingQueryResult");

  const SchemaColumn = strict({
    name: z.string(),
    type: z.string(),
    description: z.string(),
  }).openapi("AwsPricingSchemaColumn");

  const SchemaTable = strict({
    name: z.string(),
    description: z.string(),
    sortingKey: z
      .array(z.string())
      .describe("Filtering on a prefix of these columns is what makes a query fast."),
    columns: z.array(SchemaColumn),
  }).openapi("AwsPricingSchemaTable");

  const Source = strict({
    source: z.string().describe("A platform name, or `spot` for EC2 spot prices."),
    version: z.string(),
    priceListTo: z.string().nullable().describe("Newest AWS price list in the data (UTC)."),
    syncedAt: z.string().describe("When it was loaded (UTC)."),
    priceRows: z.number().int(),
  }).openapi("AwsPricingSource");

  const Schema = strict({
    tables: z.array(SchemaTable),
    notes: z.array(z.string()).describe("Conventions a correct query depends on."),
    sources: z
      .array(Source)
      .nullable()
      .describe("How fresh each bundle is; null when the warehouse could not be reached."),
  }).openapi("AwsPricingSchema");

  const tableList = TABLES.map((t) => `- \`${t.name}\`: ${t.comment}`).join("\n");

  registry.registerPath({
    method: "get",
    path: "/api/v1/aws-pricing/schema",
    tags: ["AWS pricing"],
    summary: "Describe the AWS pricing tables",
    description:
      "Every table and column of the AWS pricing warehouse with what it holds, the notes a " +
      "correct query depends on, and how fresh each source is. Needs no scope.\n\nTables:\n\n" +
      tableList +
      "\n\nNotes:\n\n" +
      SCHEMA_NOTES.map((n) => `- ${n}`).join("\n"),
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "The schema", content: { "application/json": { schema: Schema } } },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/aws-pricing/query",
    tags: ["AWS pricing"],
    summary: "Run a read-only SQL query over AWS pricing data",
    description:
      "Runs one read-only ClickHouse statement against the AWS pricing warehouse: every " +
      "instance type's specs and every price AWS has listed for it (on demand, reserved and " +
      "EC2 spot), in every region, with history, for EC2, RDS, ElastiCache, OpenSearch, " +
      "Redshift, DocumentDB, Neptune, MemoryDB, DAX, SageMaker, EMR and GameLift. It is the " +
      "data behind instances.infrawrench.com. Needs no scope. Use `GET /api/v1/aws-pricing/schema` " +
      "for the columns, or the tables below; filter `prices` on `platform` and `current`.\n\n" +
      tableList,
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: QueryRequest } }, required: true },
    },
    responses: {
      200: {
        description: "The result",
        content: { "application/json": { schema: QueryResult } },
      },
      400: {
        description:
          "The query was refused: not read-only, more than one statement, or ClickHouse's own " +
          "error (unknown column, syntax), with its message",
        content: { "application/json": { schema: ErrorResponse } },
      },
      401: ErrorResponses[401],
      502: {
        description: "The warehouse could not answer; try again shortly",
        content: { "application/json": { schema: ErrorResponse } },
      },
      503: ErrorResponses[503],
      504: {
        description: "The query ran longer than 30 seconds",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });
}
