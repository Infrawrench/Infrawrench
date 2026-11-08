/**
 * Dependency graph: `/api/org/:orgId/dependency-graph`, the endpoint
 * definitions.
 *
 * `?resourceId=` narrows it to one resource's direct neighbourhood. The
 * assembly lives in `services/dependency-graph.ts`, shared with the
 * blast-radius endpoint.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { OrgAuth } from "../../middleware-tags";
import { OrgParams, ResourceId, Uuid } from "../../schemas/common";
import { describeQuery } from "../../schemas/params";

const DependencyGraphNode = Schema.Struct({
  id: ResourceId,
  displayName: Schema.String,
  pluginId: Schema.String,
  pluginDisplayName: Schema.String,
  pluginLogoSvg: Schema.String.annotate({ description: "Inline SVG markup; may be empty." }),
  resourceTypeId: Schema.String,
  resourceTypeLabel: Schema.String,
  accountId: Uuid,
  accountName: Schema.String,
}).annotate({ identifier: "DependencyGraphNode" });

const DependencyGraphEdge = Schema.Struct({
  consumerResourceId: ResourceId.annotate({
    description: "The resource holding the reference; it depends on the provider.",
  }),
  consumerFieldKey: Schema.String.annotate({
    description:
      'The consumer field the reference fills. "parent" for containment edges, where the ' +
      "link is the resource hierarchy itself rather than a field.",
  }),
  providerResourceId: ResourceId.annotate({ description: "The resource being depended on." }),
  providerOutputKey: Schema.String.annotate({
    description:
      "The provider output or identity the reference reads; an output key for output " +
      'references, the matched identity ("externalId", "name", "endpoint"…) for inferred edges.',
  }),
  kind: Schema.optionalKey(
    Schema.Literals(["output-ref", "declared", "containment", "field-match"]).annotate({
      description:
        "Where the edge came from: `output-ref` is wired by hand, `declared` from the plugin's " +
        "own `dependsOn` rule for the resource type, `containment` from the synced parent/child " +
        "link, `field-match` from a field value that exactly matches another resource's " +
        "identity. Absent means `output-ref`.",
    }),
  ),
  label: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'How the plugin words the relationship ("in VPC", "guarded by"), when it declared one.',
    }),
  ),
}).annotate({ identifier: "DependencyGraphEdge" });

export const DependencyGraphResponse = Schema.Struct({
  nodes: Schema.Array(DependencyGraphNode).annotate({
    description: "Org resources that participate in at least one edge.",
  }),
  edges: Schema.Array(DependencyGraphEdge).annotate({
    description:
      "Directed depends-on edges (consumer → provider), deduped per consumer field and provider.",
  }),
  truncated: Schema.Boolean.annotate({
    description:
      "True when inference hit its edge cap and the returned graph is a partial view of the org.",
  }),
}).annotate({ identifier: "DependencyGraphResponse" });

export class DependencyGraphGroup extends HttpApiGroup.make("dependencyGraph")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      query: {
        resourceId: Schema.optionalKey(ResourceId),
      },
      success: DependencyGraphResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(
        OpenApi.Summary,
        "The org's resource dependency graph, from synced cloud data and output references",
      )
      .annotate(SuccessDescription, "Nodes and depends-on edges")
      .annotate(
        OpenApi.Transform,
        describeQuery({
          resourceId:
            "Narrow the graph to this resource's direct neighbourhood; only edges with it at " +
            "one end, and only the nodes those edges touch. Omit for the whole org.",
        }),
      ),
  )
  .prefix("/api/org/:orgId/dependency-graph")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Associations") {}

export class DependencyGraphApi extends withApiDefaults(
  HttpApi.make("dependency-graph").add(DependencyGraphGroup),
) {}
