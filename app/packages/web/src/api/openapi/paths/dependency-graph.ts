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
    description: "The resource holding the output reference — it depends on the provider.",
  }),
  consumerFieldKey: z.string().openapi({ description: "The consumer field the reference fills." }),
  providerResourceId: ResourceId.openapi({ description: "The resource being depended on." }),
  providerOutputKey: z
    .string()
    .openapi({ description: "The provider output the reference reads." }),
}).openapi("DependencyGraphEdge");

const DependencyGraphResponse = strict({
  nodes: z.array(DependencyGraphNode).openapi({
    description: "Org resources that participate in at least one output reference.",
  }),
  edges: z.array(DependencyGraphEdge).openapi({
    description: "Directed depends-on edges (consumer → provider), deduped per consumer field.",
  }),
}).openapi("DependencyGraphResponse");

export function registerDependencyGraphPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dependency-graph",
    tags: ["Associations"],
    summary: "The org's resource dependency graph, built from output references",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Nodes and depends-on edges",
        content: { "application/json": { schema: DependencyGraphResponse } },
      },
    },
  });
}
