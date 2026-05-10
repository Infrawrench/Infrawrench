import { z } from "../zod";
import { strict, ErrorResponses, Uuid } from "../common";
import type { BuildContext } from "../index";

const CreateOrgRequest = strict({
  displayName: z.string().min(1).openapi({ example: "Acme Inc" }),
}).openapi("CreateOrgRequest");

const CreateOrgResponse = strict({
  id: Uuid,
  displayName: z.string(),
}).openapi("Organization");

export function registerOrgPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "post",
    path: "/api/orgs",
    tags: ["Organizations"],
    summary: "Create a new organization",
    description: "The caller becomes the `owner` of the new organization.",
    request: {
      body: { content: { "application/json": { schema: CreateOrgRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CreateOrgResponse } },
      },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
    },
  });
}
