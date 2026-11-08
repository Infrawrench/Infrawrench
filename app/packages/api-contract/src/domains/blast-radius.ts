/**
 * Blast radius: `/api/org/:orgId/blast-radius`, the endpoint definitions.
 *
 * `resourceId` is a query parameter, not a path segment: composite resource
 * ids contain slashes and colons, which is why the ownership and lease routes
 * take it the same way.
 *
 * `resources:read`, not `resources:delete`. The report is a read over the
 * dependency graph, the flow warehouse and a dozen org objects the caller can
 * already list: gating it on the delete permission would mean the people who
 * *cannot* delete a resource also cannot find out what would break, which is
 * exactly backwards for the person writing the change request.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams, ResourceId } from "../http/schemas/common";
import { describeQuery } from "../http/schemas/params";

const edgeKinds = ["output-ref", "declared", "containment", "field-match"] as const;

const BlastRadiusNode = Schema.Struct({
  id: ResourceId,
  displayName: Schema.String,
  pluginId: Schema.String,
  pluginDisplayName: Schema.String,
  pluginLogoSvg: Schema.String.annotate({ description: "Inline SVG markup; may be empty." }),
  resourceTypeId: Schema.String,
  resourceTypeLabel: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
}).annotate({ identifier: "BlastRadiusNode" });

const BlastRadiusVia = Schema.Struct({
  fieldKey: Schema.String.annotate({ description: "The dependant's field holding the reference." }),
  outputKey: Schema.String.annotate({
    description: "The output or identity the reference reads.",
  }),
  kind: Schema.optionalKey(
    Schema.Literals(edgeKinds).annotate({
      description:
        "Where the edge came from. Absent means `output-ref`: a reference wired by hand.",
    }),
  ),
  label: Schema.optionalKey(
    Schema.String.annotate({
      description: 'How the plugin words the relationship ("in VPC"), when it declared one.',
    }),
  ),
});

const BlastRadiusDependant = Schema.Struct({
  node: BlastRadiusNode,
  depth: Schema.Int.annotate({
    description:
      "Shortest hop count from the resource: 1 is a direct dependant, 2 or more reached it " +
      "through something else. The resource itself is never listed.",
  }),
  via: Schema.optionalKey(
    BlastRadiusVia.annotate({
      description:
        "How a direct dependant reaches the resource. Absent for transitive dependants, whose " +
        "path is several edges and has no single caption.",
    }),
  ),
}).annotate({ identifier: "BlastRadiusDependant" });

const BlastRadiusReference = Schema.Struct({
  kind: Schema.Literals([
    "dashboard",
    "custom-graph",
    "probe",
    "status-page",
    "metric-alert",
    "lease",
    "schedule",
    "workflow",
    "log-query",
    "owner",
  ]).annotate({ description: "What kind of object names the resource." }),
  id: Schema.String.annotate({ description: "The referring object's own id." }),
  name: Schema.String,
  detail: Schema.optionalKey(
    Schema.String.annotate({ description: "One extra clause of context." }),
  ),
  userFacing: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Set when the reference is visible outside the organization; a published status page " +
        "component, or the probe behind one. Any user-facing reference makes the report high " +
        "severity on its own.",
    }),
  ),
}).annotate({ identifier: "BlastRadiusReference" });

const BlastRadiusFlowPeer = Schema.Struct({
  ref: Schema.String.annotate({
    description: "The peer's flow ref; a provider resource id, or a class token like `internet`.",
  }),
  label: Schema.String,
  direction: Schema.Literals(["egress", "ingress"]).annotate({
    description: "Relative to the resource being deleted, not to the row the provider captured.",
  }),
  scope: Schema.String.annotate({ description: "The boundary the traffic crossed." }),
  bytes: Schema.Finite,
  estimatedCost: Schema.Finite,
  currency: Schema.String,
  days: Schema.Int.annotate({
    description: "Days in the window this peer appeared on; a spike versus a standing flow.",
  }),
  resourceId: Schema.NullOr(ResourceId).annotate({
    description:
      "The peer's Infrawrench resource id when its flow ref resolved to exactly one synced " +
      "resource. Null when it resolved to none (an endpoint outside the organization) and " +
      "also when it resolved to several; a provider id is only unique within one plugin and " +
      "account, and a flow record does not name the peer's account, so a contested ref is " +
      "reported unlinked with the reason in `unchecked` rather than attributed to a guess.",
  }),
}).annotate({ identifier: "BlastRadiusFlowPeer" });

const BlastRadiusGap = Schema.Struct({
  kind: Schema.Literals([
    "network-flows",
    "dependency-graph",
    "references",
    "workflow-source",
    "custom-graph-source",
  ]),
  reason: Schema.String.annotate({
    description: "A full sentence, written to be rendered verbatim to the person deleting.",
  }),
}).annotate({ identifier: "BlastRadiusGap" });

export const BlastRadiusReport = Schema.Struct({
  resourceId: ResourceId,
  resource: Schema.NullOr(BlastRadiusNode).annotate({
    description: "The resource itself, when it participates in the dependency graph.",
  }),
  dependants: Schema.Array(BlastRadiusDependant).annotate({
    description: "Affected resources, direct first then by depth.",
  }),
  directCount: Schema.Int,
  transitiveCount: Schema.Int,
  references: Schema.Array(BlastRadiusReference).annotate({
    description: "Objects naming the resource without depending on it, user-facing ones first.",
  }),
  flowPeers: Schema.Array(BlastRadiusFlowPeer).annotate({
    description:
      "Measured network peers over the last 14 days, heaviest first. Empty when flow " +
      "collection is off, see `unchecked`.",
  }),
  flowTotals: Schema.NullOr(
    Schema.Struct({
      bytes: Schema.Finite,
      estimatedCost: Schema.Finite,
      currency: Schema.String,
    }),
  ).annotate({
    description:
      "Totals over `flowPeers`, or null when traffic could not be measured at all. Zeroed " +
      "totals mean collection is on and the resource is quiet; null means nobody looked.",
  }),
  unchecked: Schema.Array(BlastRadiusGap).annotate({
    description:
      "What the report could not look at. An empty `dependants` list with a non-empty " +
      "`unchecked` list is not a clean bill of health, and surfaces must not render it as one.",
  }),
  severity: Schema.Literals(["none", "low", "medium", "high", "unknown"]).annotate({
    description:
      "`high` for anything user-facing or five or more direct dependants; `unknown` when " +
      "nothing was found but something could not be checked.",
  }),
  headline: Schema.String.annotate({ description: "One sentence, ready to render." }),
}).annotate({ identifier: "BlastRadiusReport" });

export class BlastRadiusGroup extends HttpApiGroup.make("blastRadius")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      query: {
        resourceId: ResourceId,
      },
      success: BlastRadiusReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "What breaks if this resource is deleted")
      .annotate(
        OpenApi.Description,
        "An impact report for one resource, assembled from the dependency graph walked inbound, " +
          "network flow attribution, and the org objects that name the resource without depending " +
          "on it (dashboards, custom graphs, probes, status pages, metric alerts, leases, " +
          "schedules, saved log queries, workflows, and its recorded owner).\n\n" +
          "The endpoint answers 200 with a partial report rather than failing when a source is " +
          "unavailable; `unchecked` says which, in prose.",
      )
      .annotate(SuccessDescription, "The impact report")
      .annotate(InvalidRequestMessage, "Missing resourceId")
      .annotate(
        OpenApi.Transform,
        describeQuery({
          resourceId:
            "The resource to report on. A query parameter rather than a path segment because " +
            "composite resource ids contain slashes and colons.",
        }),
      ),
  )
  .prefix("/api/org/:orgId/blast-radius")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Associations") {}

export class BlastRadiusApi extends withApiDefaults(
  HttpApi.make("blast-radius").add(BlastRadiusGroup),
) {}
