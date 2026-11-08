/**
 * Cost push: `POST /api/org/:orgId/costs/rows`, the endpoint definition.
 *
 * Lets a server outside Infrawrench report spend it already knows about (a
 * parsed SaaS invoice, an internal chargeback, a colo bill) into the same
 * `cost_daily` table the provider collectors write to.
 *
 * Outside the org tree's auth chain: it authenticates itself
 * (`http/org-request-caller.ts`), because an unattended server has nothing
 * but an `iwk_` key, and its refusals keep their published sentences. It
 * shares the `/costs` prefix with the costs, anomaly feedback and export job
 * domains, none of which has a `/rows` path or a parameter in the first
 * segment, so no other endpoint can capture this one.
 *
 * The body is the envelope only. Per-row validation belongs to the shared
 * ingest module, whose messages name the offending row index and are
 * identical to the ones `infra.costs.write` gives workflow authors, so each
 * row is read as any JSON object and documented as {@link PushedCostRow}.
 */
import { Predicate, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { lengthBetween, maxLength, pattern } from "../schemas";
import {
  DocumentedPermission,
  InvalidRequestMessage,
  SuccessDescription,
} from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";

/** The most rows one call may push (`MAX_EXTERNAL_COST_ROWS_PER_CALL` in server-core). */
export const MAX_PUSHED_ROWS = 5000;

const RowText = Schema.String.check(maxLength(256));

export const PushedCostRow = Schema.Struct({
  date: Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
    description: "UTC day the spend belongs to.",
    examples: ["2026-07-01"],
  }),
  currency: Schema.String.check(...lengthBetween(3, 3)).annotate({ examples: ["USD"] }),
  amount: Schema.Finite.annotate({
    description: "Money for this day/dimension combination. Negative for credits.",
  }),
  service: Schema.optionalKey(
    RowText.annotate({
      examples: ["Snowflake Compute"],
      description: "Becomes a group/filter value.",
    }),
  ),
  region: Schema.optionalKey(RowText),
  resourceId: Schema.optionalKey(
    RowText.annotate({
      description: "Opaque id of the thing being billed; groups the `resource` dimension.",
    }),
  ),
  tags: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description:
        "Cost-allocation tags, at most 32. Keys starting with `infrawrench:` are reserved and rejected.",
    }),
  ),
  usageAmount: Schema.optionalKey(Schema.Finite),
  usageUnit: Schema.optionalKey(RowText),
  accountId: Schema.optionalKey(
    Uuid.annotate({
      description:
        "Attribute this row to a connected account. Must belong to the calling organization. " +
        "Omit to attribute it to the source itself.",
    }),
  ),
}).annotate({ identifier: "PushedCostRow" });

/** Any JSON object (the route's `z.record(z.unknown())`), documented as {@link PushedCostRow}. */
const isRowObject = (value: unknown): value is typeof PushedCostRow.Type =>
  Predicate.isObject(value) && !Array.isArray(value);

const EnvelopeRow = Schema.Any.pipe(
  Schema.refine(isRowObject, {
    representation: {
      id: "infrawrench/pushedCostRow",
      payload: null,
      schemas: [PushedCostRow.ast],
    },
    toJsonSchema: ({ schemas }) => schemas[0] ?? {},
  }),
);

export const CostPushRequest = Schema.Struct({
  source: documentedAs(
    Schema.String.check(maxLength(64)).annotate({
      examples: ["snowflake-invoices"],
      description:
        "Stable slug naming the system that owns these rows: letters, digits, `.`, `_` and `-`. " +
        "It groups the rows under an `External` provider and an `external:<source>` account, " +
        "and re-pushing the same source over the same days restates only its own rows.",
    }),
  ),
  rows: Schema.mutable(Schema.Array(EnvelopeRow)).check(maxLength(MAX_PUSHED_ROWS)),
}).annotate({ identifier: "CostPushRequest" });

export const CostPushResponse = Schema.Struct({ written: Schema.Int }).annotate({
  identifier: "CostPushResponse",
});

export class CostIngestGroup extends HttpApiGroup.make("costIngest")
  .add(
    HttpApiEndpoint.post("push", "/rows", {
      params: OrgParams,
      payload: CostPushRequest,
      success: CostPushResponse,
      error: [BadRequest],
    })
      .annotate(OpenApi.Summary, "Push cost rows from your own systems")
      .annotate(
        OpenApi.Description,
        "Reports spend Infrawrench has no provider plugin for (a parsed SaaS invoice, an internal " +
          "chargeback, a colo bill) into the same store the provider collectors write to, so it " +
          "appears in cost graphs, dimension filters, and budgets alongside everything else.\n\n" +
          "Rows are grouped under a caller-chosen `source`. Writes are idempotent per " +
          "`(source, day, service, region, resourceId, tags, currency)`: pushing the same day again " +
          "restates that day rather than adding to it, so a nightly job can safely re-push a trailing " +
          "window. Rows pushed under a source can never overwrite rows a provider collector wrote.\n\n" +
          "The whole batch is validated before anything is stored, so a 400 means nothing was written.",
      )
      .annotate(SuccessDescription, "Rows written")
      .annotate(InvalidRequestMessage, "Invalid body")
      .annotate(DocumentedPermission, "costs:write"),
  )
  .prefix("/api/org/:orgId/costs")
  .annotate(OpenApi.Title, "Costs") {}

export class CostIngestApi extends withApiDefaults(
  HttpApi.make("costIngest").add(CostIngestGroup),
) {}
