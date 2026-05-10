import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam, ResourceId } from "../common";
import type { BuildContext } from "../index";

const AssociationRequest = strict({
  consumerResourceId: ResourceId,
  consumerFieldKey: z.string(),
  providerResourceId: ResourceId,
  providerOutputKey: z.string(),
  providerPluginId: z.string(),
  providerResourceTypeId: z.string(),
  providerAccountId: Uuid,
}).openapi("AssociationRequest");

const LiteralAssociationRequest = strict({
  resourceId: ResourceId,
  fieldKey: z.string(),
  plaintextValue: z.string(),
}).openapi("LiteralAssociationRequest");

export function registerAssociationPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/associations",
    tags: ["Associations"],
    summary: "Wire one resource's output into another resource's secret field",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AssociationRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/associations/literal",
    tags: ["Associations"],
    summary: "Set a secret field to a literal plaintext value",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: LiteralAssociationRequest } },
        required: true,
      },
    },
    responses: {
      200: { description: "Stored", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
