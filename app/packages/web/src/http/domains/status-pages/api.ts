/**
 * Public status pages: the endpoint definitions.
 *
 * Two groups, and keeping them apart is the point:
 *
 * - `statusPages` (`/api/org/:orgId/status-pages`) is on the org tree and
 *   manages the rows. Permissions ride the probes stance (`resources:read` /
 *   `resources:write`): a status page is a view over probes, and whoever may
 *   create the monitoring may decide what of it is public. The write bodies
 *   are picked by hand in the handlers (a field of the wrong type is ignored,
 *   a bad component is refused in its own words), so those endpoints are
 *   served raw and the bodies here are documentation.
 * - `publicStatus` (`/api/status/:slug`) has **no** auth middleware at all,
 *   because its whole purpose is to answer callers who have no account. It
 *   takes no credentials, reads no session, and its handler (`./public.ts`)
 *   can only ever reach `getPublicStatusPage`, which assembles a payload with
 *   no org identifiers in it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, Security, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";

const ProbeStatus = Schema.Literals(["up", "down", "unknown"]);

const StatusComponentState = Schema.Literals([
  "operational",
  "degraded",
  "down",
  "unknown",
]).annotate({
  description:
    "A component's public state. A paused probe reads `unknown` regardless of its last " +
    "result: the page is a claim about what is being checked now.",
});

const StatusPageState = Schema.Literals([
  "operational",
  "degraded",
  "major_outage",
  "unknown",
]).annotate({
  description:
    "Rollup over the components. `degraded` means some but not all are down; components with " +
    "no data are ignored rather than dragging the page to unknown.",
});

const NullableString = Schema.NullOr(Schema.String);

export const StatusPageComponent = Schema.Struct({
  id: Uuid,
  probeId: Uuid,
  label: NullableString.annotate({
    description: "Public name; null falls back to the probe's own name.",
  }),
  groupName: NullableString,
  position: Schema.Int.annotate({ description: "Ascending display order." }),
  probeName: Schema.String.annotate({ description: "The probe's internal name, editor-only." }),
  probeStatus: ProbeStatus,
  probeEnabled: Schema.Boolean.annotate({ description: "False when the probe is paused." }),
}).annotate({ identifier: "StatusPageComponent" });

export const StatusPage = Schema.Struct({
  id: Uuid,
  slug: Schema.String.annotate({
    description:
      "The public URL segment, and the page's only access credential. Generated with real " +
      "entropy rather than derived from the title.",
  }),
  title: Schema.String,
  description: NullableString,
  published: Schema.Boolean.annotate({
    description: "False until deliberately published; a fresh page is never reachable.",
  }),
  showHistory: Schema.Boolean,
  showUptime: Schema.Boolean,
  supportUrl: NullableString,
  components: Schema.Array(StatusPageComponent),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "StatusPage" });

export const StatusPageListResponse = Schema.Struct({
  pages: Schema.Array(StatusPage),
}).annotate({ identifier: "StatusPageListResponse" });

const StatusPageComponentInput = Schema.Struct({
  probeId: Uuid,
  label: Schema.optionalKey(NullableString),
  groupName: Schema.optionalKey(NullableString),
}).annotate({ identifier: "StatusPageComponentInput" });

const StatusPageCreate = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(NullableString),
  published: Schema.optionalKey(Schema.Boolean.annotate({ description: "Defaults to false." })),
  showHistory: Schema.optionalKey(Schema.Boolean),
  showUptime: Schema.optionalKey(Schema.Boolean),
  supportUrl: Schema.optionalKey(NullableString),
  components: Schema.optionalKey(
    Schema.Array(StatusPageComponentInput).annotate({
      description: "Order is significant; it is the public render order.",
    }),
  ),
}).annotate({ identifier: "StatusPageCreate" });

const StatusPagePatch = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(NullableString),
  published: Schema.optionalKey(Schema.Boolean),
  showHistory: Schema.optionalKey(Schema.Boolean),
  showUptime: Schema.optionalKey(Schema.Boolean),
  supportUrl: Schema.optionalKey(NullableString),
  components: Schema.optionalKey(
    Schema.Array(StatusPageComponentInput).annotate({
      description: "When present, replaces the whole set.",
    }),
  ),
}).annotate({ identifier: "StatusPagePatch" });

const StatusHistoryDay = Schema.Struct({
  day: Schema.String.annotate({ description: "`YYYY-MM-DD`, UTC.", examples: ["2026-08-07"] }),
  uptime: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Fraction of the day the endpoint was up (0–1), or null when nothing was recorded.",
  }),
}).annotate({ identifier: "StatusHistoryDay" });

const PublicStatusComponent = Schema.Struct({
  id: Uuid.annotate({ description: "Stable per page. Deliberately not the probe id." }),
  name: Schema.String,
  groupName: NullableString,
  state: StatusComponentState,
  uptime24h: Schema.NullOr(Schema.Finite),
  history: Schema.Array(StatusHistoryDay).annotate({
    description: "Oldest first; empty when history is hidden.",
  }),
}).annotate({ identifier: "PublicStatusComponent" });

export const PublicStatusPage = Schema.Struct({
  title: Schema.String,
  description: NullableString,
  state: StatusPageState,
  summary: Schema.String.annotate({ description: "One sentence describing `state`." }),
  components: Schema.Array(PublicStatusComponent),
  supportUrl: NullableString,
  showHistory: Schema.Boolean,
  showUptime: Schema.Boolean,
  historyDays: Schema.Int,
  generatedAt: IsoDateTime,
}).annotate({ identifier: "PublicStatusPage" });

export class StatusPagesGroup extends HttpApiGroup.make("statusPages")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: StatusPageListResponse })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List status pages")
      .annotate(
        OpenApi.Description,
        "Every status page in the organization, with the probes each publishes and whether it " +
          "is currently reachable.",
      )
      .annotate(SuccessDescription, "The organization's status pages"),
    // No `GET /:id`: the list already returns every page in full, components
    // and all, so a single-page read would be a second way to say the same thing.
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: StatusPageCreate,
      success: StatusPage.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a status page")
      .annotate(
        OpenApi.Description,
        "Creates a page with a freshly generated slug. `published` defaults to false, so " +
          "creating a page never exposes anything; publish it as a separate, deliberate step.",
      )
      .annotate(SuccessDescription, "The created page")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: StatusPagePatch,
      success: StatusPage,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update a status page")
      .annotate(
        OpenApi.Description,
        "Omitted fields keep their value. `components`, when present, replaces the whole " +
          "ordered set: which is also how a reorder is expressed.",
      )
      .annotate(SuccessDescription, "The updated page")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("rotateSlug", "/:id/rotate-slug", {
      params: OrgIdParams,
      success: StatusPage,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Issue a new public link")
      .annotate(
        OpenApi.Description,
        "Replaces the slug, revoking the current public URL immediately; the reroll for a link " +
          "that ended up somewhere unintended. The page stays published.",
      )
      .annotate(SuccessDescription, "The page, with its new slug"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a status page")
      .annotate(
        OpenApi.Description,
        "The page's link stops working. The probes it published are untouched.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/status-pages")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Status pages") {}

/**
 * The public reader. No middleware: see the module note. An unpublished page
 * and a nonexistent slug answer the same 404, so the endpoint cannot be used
 * to probe which slugs are real.
 */
export class PublicStatusGroup extends HttpApiGroup.make("publicStatus")
  .add(
    HttpApiEndpoint.get("read", "/:slug", {
      params: { slug: Schema.String },
      success: PublicStatusPage,
      error: NotFound,
    })
      .annotate(OpenApi.Summary, "Read a public status page")
      .annotate(
        OpenApi.Description,
        "**Unauthenticated.** The only endpoint in this API that takes no credentials; a " +
          "status page exists for people with no account. The payload carries labels, states " +
          "and uptime history only: probe URLs, resource and account ids, the organization id " +
          "and error detail are never included. An unpublished page and an unknown slug both " +
          "answer 404, so the endpoint cannot be used to confirm that a slug is real.",
      )
      .annotate(SuccessDescription, "The public status snapshot")
      // Opts out of the document's global `security`, which would otherwise
      // advertise bearer/cookie auth this route neither wants nor reads, and
      // make generated clients attach a token to an anonymous endpoint.
      .annotate(Security, []),
  )
  .prefix("/api/status")
  .annotate(OpenApi.Title, "Status pages") {}

export class StatusPagesApi extends withApiDefaults(
  HttpApi.make("statusPages").add(StatusPagesGroup).add(PublicStatusGroup),
) {}
