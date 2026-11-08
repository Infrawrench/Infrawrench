/**
 * `/api/v1/instance-pricing`: read-only SQL over the instance pricing
 * warehouse, the endpoint definitions. `/api/v1/aws-pricing`, its path before
 * the warehouse covered other clouds, is defined too, as deprecated aliases.
 * The component schemas keep their `AwsPricing*` names so the generated
 * SDKs' types do not change.
 *
 * The table list in the descriptions is generated from the warehouse schema
 * (client-core's `PricingWarehouse`, which server-core's loader creates the
 * tables from), so the document cannot drift from the tables.
 *
 * Bearer only. The handlers authenticate themselves (`http/bearer-caller.ts`),
 * the canonical query path also accepts the key the web and desktop apps ship
 * with, and the rest of both prefixes is guarded the same way
 * (`http/prefix-guard.ts`). The query body is checked by hand, in the
 * warehouse module's own sentences, and only documented here.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { PricingWarehouse } from "@infrawrench/client-core";
import { maxLength, minLength } from "../schemas";
import { Security, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import {
  BadGateway,
  BadRequest,
  GatewayTimeout,
  ServiceUnavailable,
  Unauthorized,
} from "../http/errors";
import { describeResponse } from "../http/schemas/documented";

export const INSTANCE_PRICING_PREFIX = "/api/v1/instance-pricing";
/** The path before the warehouse covered other clouds; kept as an alias. */
export const AWS_PRICING_PREFIX = "/api/v1/aws-pricing";

const Cell = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]).annotate({
  identifier: "AwsPricingCell",
  description:
    "One value. Numbers (including ClickHouse's 64-bit integers and decimals) are JSON " +
    "numbers; DateTime is `YYYY-MM-DD hh:mm:ss` in UTC; arrays and maps are JSON text.",
});

const Column = Schema.Struct({
  name: Schema.String.annotate({ examples: ["instance_type"] }),
  type: Schema.String.annotate({ examples: ["String"], description: "The ClickHouse type." }),
}).annotate({ identifier: "AwsPricingResultColumn" });

export const AwsPricingQueryRequest = Schema.Struct({
  sql: Schema.String.check(minLength(1), maxLength(20_000)).annotate({
    description:
      "One read-only statement: SELECT or WITH (also DESCRIBE, SHOW, EXPLAIN). No FORMAT or " +
      "SETTINGS clause, no trailing second statement.",
    examples: [
      "SELECT instance_type, vcpu, memory_gib, effective_hourly_usd FROM prices WHERE platform = 'ec2' AND current AND pricing = 'on_demand' AND region = 'us-east-1' AND operating_system = 'Linux' AND tenancy = 'Shared' AND pre_installed_sw = 'NA' AND capacity_status = 'Used' AND architecture = 'arm64' ORDER BY effective_hourly_usd LIMIT 5",
    ],
  }),
  maxRows: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: PricingWarehouse.MAX_QUERY_ROWS }),
    ).annotate({
      description: `Rows to return at most. Default 1,000; at most ${PricingWarehouse.MAX_QUERY_ROWS.toLocaleString("en")}.`,
    }),
  ),
}).annotate({ identifier: "AwsPricingQueryRequest" });

export const AwsPricingQueryResult = Schema.Struct({
  columns: Schema.Array(Column),
  rows: Schema.Array(Schema.Array(Cell)).annotate({
    description: "Each row's values, in `columns` order.",
  }),
  truncated: Schema.Boolean.annotate({
    description: "More rows matched than `maxRows`; add a LIMIT or aggregate to see them all.",
  }),
  elapsedMs: Schema.Int,
}).annotate({ identifier: "AwsPricingQueryResult" });

const SchemaColumn = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  description: Schema.String,
}).annotate({ identifier: "AwsPricingSchemaColumn" });

const SchemaTable = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  sortingKey: Schema.Array(Schema.String).annotate({
    description: "Filtering on a prefix of these columns is what makes a query fast.",
  }),
  columns: Schema.Array(SchemaColumn),
}).annotate({ identifier: "AwsPricingSchemaTable" });

const Source = Schema.Struct({
  source: Schema.String.annotate({
    description: "A platform name, or `spot` for EC2 spot prices.",
  }),
  version: Schema.String,
  priceListTo: Schema.NullOr(Schema.String).annotate({
    description: "Newest price list in the data (UTC).",
  }),
  syncedAt: Schema.String.annotate({ description: "When it was loaded (UTC)." }),
  priceRows: Schema.Int,
}).annotate({ identifier: "AwsPricingSource" });

export const AwsPricingSchema = Schema.Struct({
  tables: Schema.Array(SchemaTable),
  notes: Schema.Array(Schema.String).annotate({
    description: "Conventions a correct query depends on.",
  }),
  sources: Schema.NullOr(Schema.Array(Source)).annotate({
    description: "How fresh each bundle is; null when the warehouse could not be reached.",
  }),
}).annotate({ identifier: "AwsPricingSchema" });

const tableList = PricingWarehouse.QUERYABLE_TABLES.map(
  (t) => `- \`${t.name}\`: ${t.comment}`,
).join("\n");

const schemaDescription =
  "Every table and column of the instance pricing warehouse with what it holds, the notes a " +
  "correct query depends on, and how fresh each source is. Needs no scope.\n\nTables:\n\n" +
  tableList +
  "\n\nNotes:\n\n" +
  PricingWarehouse.SCHEMA_NOTES.map((n) => `- ${n}`).join("\n");

const queryDescription =
  "Runs one read-only ClickHouse statement against the instance pricing warehouse: every " +
  "instance type's specs and every price its provider has listed for it (on demand, " +
  "committed terms and EC2 spot), in every region, with history. It covers AWS EC2, RDS, " +
  "ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune, MemoryDB, DAX, SageMaker, EMR and " +
  "GameLift, RunPod GPU types and CPU pods, Alibaba Cloud ECS, Azure virtual machines, " +
  "Google Cloud Compute Engine, Hetzner cloud servers and Server Auction listings, OVHcloud " +
  "Public Cloud and eco servers, Oracle Cloud compute and IBM Cloud Virtual Servers for VPC. " +
  "It is the data behind " +
  "instances.infrawrench.com. Needs no scope. Use `GET /api/v1/instance-pricing/schema` for " +
  "the columns, or the tables below; filter `prices` on `platform` and `current`. The " +
  "Infrawrench web and desktop apps call this path with a key built into them; that key is " +
  "licensed for those apps only, so your own code should use an API key.\n\n" +
  tableList;

const alias = (path: string) =>
  `Deprecated alias of \`${path}\`, its path before the warehouse covered clouds other than ` +
  "AWS; it behaves identically. Use the new path.";

/** The query's own error descriptions, beside the shared 401 and 503. */
const queryErrorDescriptions = (operation: Record<string, unknown>) =>
  describeResponse(
    400,
    "The query was refused: not read-only, more than one statement, or ClickHouse's own " +
      "error (unknown column, syntax), with its message",
  )(
    describeResponse(
      502,
      "The warehouse could not answer; try again shortly",
    )(describeResponse(504, "The query ran longer than 30 seconds")(operation)),
  );

const schemaEndpoint = <const Name extends string, const Path extends `/${string}`>(
  name: Name,
  path: Path,
) =>
  HttpApiEndpoint.get(name, path, { success: AwsPricingSchema, error: [Unauthorized] })
    .annotate(SuccessDescription, "The schema")
    .annotate(Security, [{ bearerAuth: [] }]);

const queryEndpoint = <const Name extends string, const Path extends `/${string}`>(
  name: Name,
  path: Path,
) =>
  HttpApiEndpoint.post(name, path, {
    payload: AwsPricingQueryRequest,
    success: AwsPricingQueryResult,
    error: [BadRequest, Unauthorized, BadGateway, ServiceUnavailable, GatewayTimeout],
  })
    .annotate(SuccessDescription, "The result")
    .annotate(OpenApi.Transform, queryErrorDescriptions)
    .annotate(Security, [{ bearerAuth: [] }]);

export class InstancePricingGroup extends HttpApiGroup.make("instancePricing")
  .add(
    schemaEndpoint("schema", `${INSTANCE_PRICING_PREFIX}/schema`)
      .annotate(OpenApi.Summary, "Describe the instance pricing tables")
      .annotate(OpenApi.Description, schemaDescription),
  )
  .add(
    queryEndpoint("query", `${INSTANCE_PRICING_PREFIX}/query`)
      .annotate(OpenApi.Summary, "Run a read-only SQL query over instance pricing data")
      .annotate(OpenApi.Description, queryDescription),
  )
  .add(
    schemaEndpoint("aliasSchema", `${AWS_PRICING_PREFIX}/schema`)
      .annotate(OpenApi.Summary, "Describe the instance pricing tables (deprecated path)")
      .annotate(OpenApi.Description, alias("GET /api/v1/instance-pricing/schema"))
      .annotate(OpenApi.Deprecated, true),
  )
  .add(
    queryEndpoint("aliasQuery", `${AWS_PRICING_PREFIX}/query`)
      .annotate(
        OpenApi.Summary,
        "Run a read-only SQL query over instance pricing data (deprecated path)",
      )
      .annotate(OpenApi.Description, alias("POST /api/v1/instance-pricing/query"))
      .annotate(OpenApi.Deprecated, true),
  )
  .annotate(OpenApi.Title, "Instance pricing") {}

export class InstancePricingApi extends withApiDefaults(
  HttpApi.make("instancePricing").add(InstancePricingGroup),
) {}
