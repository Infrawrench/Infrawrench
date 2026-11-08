/**
 * Search: `GET /api/org/:orgId/search`, the endpoint definition.
 *
 * Without `kinds` this is the original contract the VS Code and Raycast
 * extensions and mobile call (resources and workflows, `resources:read`);
 * with it, the command palette's index, where each kind is gated by its own
 * list route's permission. The gate therefore depends on the query, so the
 * handler owns it and the document states the common case.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { DocumentedPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { OrgParams } from "../../schemas/common";
import { SearchHit } from "../../schemas/search";

export class SearchGroup extends HttpApiGroup.make("search")
  .add(
    HttpApiEndpoint.get("search", "/", {
      params: OrgParams,
      query: {
        q: Schema.optionalKey(Schema.String),
        kinds: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "`all`, or a comma-separated list of `SearchResultKind` values. An unknown kind is a 400.",
            examples: ["cost_report,dashboard,slo"],
          }),
        ),
      },
      success: Schema.Array(SearchHit),
      error: [BadRequest, Forbidden],
    })
      .annotate(
        OpenApi.Summary,
        "Search resources, workflows and (with `kinds`) saved objects across the org",
      )
      .annotate(
        OpenApi.Description,
        "Without `kinds`: resources (capped at 50, substring match over name, account, provider " +
          "and type) and workflows; requires `resources:read`. With `kinds`: the command palette's " +
          "index. Each named kind the caller's role can read is searched (a kind it cannot read is " +
          "skipped, not refused), narrowed to the objects the caller could open (per-object sharing " +
          "for cost reports, folders, dashboards and canvases; cost visibility for budgets), and " +
          "fuzzy-ranked: every whitespace-separated token must match the name or a supporting label, " +
          "as a substring or an in-order subsequence. At most 8 hits per saved-object kind and 50 " +
          "resources; kinds are ordered by their best hit.",
      )
      .annotate(SuccessDescription, "Hits")
      .annotate(DocumentedPermission, "resources:read"),
  )
  .prefix("/api/org/:orgId/search")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Search") {}

export class SearchApi extends withApiDefaults(HttpApi.make("search").add(SearchGroup)) {}
