import { z } from "../zod";
import { strict, OrgIdParam, ResourceId, Uuid } from "../common";
import type { BuildContext } from "../context";

const DependencyGraphNode = strict({
  id: ResourceId,
  displayName: z.string(),
  pluginId: z.string(),
  pluginDisplayName: z.string(),
  pluginLogoSvg: z.string().openapi({ description: "Inline SVG markup; may be empty." }),
  resourceTypeId: z.string(),
  resourceTypeLabel: z.string(),
  accountId: Uuid,
  accountName: z.string(),
}).openapi("DependencyGraphNode");

const DependencyGraphEdge = strict({
  consumerResourceId: ResourceId.openapi({
    description: "The resource holding the reference — it depends on the provider.",
  }),
  consumerFieldKey: z.string().openapi({
    description:
      'The consumer field the reference fills. "parent" for containment edges, where the ' +
      "link is the resource hierarchy itself rather than a field.",
  }),
  providerResourceId: ResourceId.openapi({ description: "The resource being depended on." }),
  providerOutputKey: z.string().openapi({
    description:
      "The provider output or identity the reference reads — an output key for output " +
      'references, the matched identity ("externalId", "name", "endpoint"…) for inferred edges.',
  }),
  kind: z
    .enum(["output-ref", "declared", "containment", "field-match"])
    .optional()
    .openapi({
      description:
        "Where the edge came from: `output-ref` is wired by hand, `declared` from the plugin's " +
        "own `dependsOn` rule for the resource type, `containment` from the synced parent/child " +
        "link, `field-match` from a field value that exactly matches another resource's " +
        "identity. Absent means `output-ref`.",
    }),
  label: z.string().optional().openapi({
    description:
      'How the plugin words the relationship ("in VPC", "guarded by"), when it declared one.',
  }),
}).openapi("DependencyGraphEdge");

const DependencyGraphResponse = strict({
  nodes: z.array(DependencyGraphNode).openapi({
    description: "Org resources that participate in at least one edge.",
  }),
  edges: z.array(DependencyGraphEdge).openapi({
    description:
      "Directed depends-on edges (consumer → provider), deduped per consumer field and provider.",
  }),
  truncated: z.boolean().openapi({
    description:
      "True when inference hit its edge cap and the returned graph is a partial view of the org.",
  }),
}).openapi("DependencyGraphResponse");

export function registerDependencyGraphPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dependency-graph",
    tags: ["Associations"],
    summary: "The org's resource dependency graph, from synced cloud data and output references",
    request: {
      params: OrgIdParam,
      query: strict({
        resourceId: ResourceId.optional().openapi({
          description:
            "Narrow the graph to this resource's direct neighbourhood — only edges with it at " +
            "one end, and only the nodes those edges touch. Omit for the whole org.",
        }),
      }),
    },
    responses: {
      200: {
        description: "Nodes and depends-on edges",
        content: { "application/json": { schema: DependencyGraphResponse } },
      },
    },
  });
}
