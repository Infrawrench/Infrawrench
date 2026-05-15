import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const BastionStatus = z.enum(["pending", "active", "revoked"]).openapi("BastionStatus");

const Bastion = strict({
  id: Uuid,
  name: z.string(),
  tokenPrefix: z.string(),
  agentVersion: z.string().nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  status: BastionStatus,
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  createdByUserId: Uuid,
  /** True iff an agent is currently connected to this bastion's WebSocket. */
  connected: z.boolean(),
  /** Number of accounts in this org that have this bastion attached. */
  accountCount: z.number().int(),
}).openapi("Bastion");

const CreateBastionRequest = strict({ name: z.string().min(1) }).openapi("CreateBastionRequest");

const CreateBastionResponse = strict({
  id: Uuid,
  name: z.string(),
  tokenPrefix: z.string(),
  token: z.string().openapi({
    description:
      "Enrollment token in the form `iwb_<random>`. Pass to the agent container as `BASTION_TOKEN`. Returned once — not recoverable later.",
  }),
}).openapi("CreateBastionResponse");

export function registerBastionPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/bastions",
    tags: ["Bastions"],
    summary: "List bastion agents registered to this org",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Bastions",
        content: { "application/json": { schema: z.array(Bastion) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/bastions",
    tags: ["Bastions"],
    summary: "Register a new bastion (returns the enrollment token once)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateBastionRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CreateBastionResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/bastions/{id}",
    tags: ["Bastions"],
    summary: "Revoke a bastion — accounts referencing it have their bastion binding cleared",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
