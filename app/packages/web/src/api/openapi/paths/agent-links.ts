import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime, Ok } from "../common";
import type { BuildContext } from "../context";

/**
 * Agent links: a platform (Nibblets, ...) that a person approved to mint
 * scoped agents in one organization. Three audiences: the platform before it
 * has a credential (unauthenticated device flow), the person approving it
 * (session), and the linked platform (`agentLinkCredential`, an `iwl_` token).
 */

const ErrorWithCode = strict({
  error: z.string(),
  code: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  agentId: z.string().optional(),
  providers: z.array(z.string()).optional(),
}).openapi("AgentLinkError");

const errorWith = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorWithCode } },
});

const LinkRequest = strict({
  platform: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().min(1).max(80),
  requestedScopes: z.array(z.string()).optional().openapi({
    description: "Pre-ticks the ceiling on the approval page. Unknown strings are ignored.",
  }),
}).openapi("AgentLinkRequest");

const LinkRequestStarted = strict({
  deviceCode: z.string().openapi({ description: "Secret to the platform; poll with it." }),
  userCode: z.string().openapi({ description: "`XXXX-XXXX`, shown to the person." }),
  verificationUrl: z.string().url(),
  verificationUrlComplete: z.string().url(),
  expiresIn: z.number().int().openapi({ description: "Seconds." }),
  interval: z.number().int().openapi({ description: "Minimum seconds between polls." }),
}).openapi("AgentLinkRequestStarted");

const ScopeGroup = strict({
  title: z.string(),
  scopes: z.array(strict({ value: z.string(), label: z.string() })),
}).openapi("AgentLinkScopeGroup");

const LinkProvider = strict({ id: z.string(), displayName: z.string() }).openapi(
  "AgentLinkProvider",
);

const linkInfoShape = {
  id: Uuid,
  organizationId: Uuid,
  organizationName: z.string(),
  platform: z.string(),
  label: z.string(),
  scopes: z.array(z.string()).openapi({ description: "The ceiling as approved." }),
  effectiveScopes: z.array(z.string()).openapi({
    description:
      "The ceiling as it stands now: approved ∩ the approver's current role (no elevation) − " +
      "permissions no agent may hold. Agents can only be granted scopes from here.",
  }),
  narrowableScopes: z.array(z.string()).openapi({
    description:
      "The scopes in `effectiveScopes` that `providers` can limit (resources, secrets, object " +
      "storage). An agent given `providers` may hold only these; any other scope is a " +
      "`scope_not_allowed`, because it would stay organization-wide.",
  }),
  scopeGroups: z.array(ScopeGroup).openapi({
    description: "`effectiveScopes` grouped and labelled as the Infrawrench pickers show them.",
  }),
  providers: z.array(LinkProvider).openapi({
    description: "Plugins the organization has at least one connected account for.",
  }),
  approvedBy: strict({ email: z.string() }).nullable(),
  createdAt: IsoDateTime,
};

const LinkInfo = strict(linkInfoShape).openapi("AgentLinkInfo");

const OrgLinkSummary = strict({
  ...linkInfoShape,
  credentialPrefix: z.string().nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
}).openapi("AgentLinkSummary");

const LinkPoll = z
  .union([
    strict({ status: z.enum(["pending", "denied", "expired"]) }),
    strict({
      status: z.literal("approved"),
      credential: z.string().openapi({
        description: "`iwl_` link credential. Returned exactly once; later polls read `expired`.",
      }),
      link: LinkInfo,
    }),
  ])
  .openapi("AgentLinkPoll");

const LinkLookupOrg = strict({
  id: Uuid,
  name: z.string(),
  canApprove: z.boolean().openapi({ description: "You hold `team:invite` there." }),
  grantableScopes: z.array(z.string()).openapi({
    description: "What you could put in the ceiling there; empty when `canApprove` is false.",
  }),
}).openapi("AgentLinkLookupOrganization");

const LinkLookup = strict({
  platform: z.string(),
  label: z.string(),
  requestedScopes: z.array(z.string()),
  expiresAt: IsoDateTime,
  organizations: z.array(LinkLookupOrg),
}).openapi("AgentLinkLookup");

const CodeBody = strict({ code: z.string() }).openapi("AgentLinkCode");
const ApproveBody = strict({
  code: z.string(),
  organizationId: Uuid,
  scopes: z.array(z.string()).min(1).openapi({ description: "The ceiling." }),
}).openapi("AgentLinkApprove");

export const PlatformAgent = strict({
  id: Uuid,
  externalId: z.string(),
  label: z.string(),
  scopes: z.array(z.string()),
  providers: z.array(z.string()).openapi({ description: "Empty means every provider." }),
  credentialPrefix: z.string().nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
}).openapi("PlatformAgent");

const CreateAgent = strict({
  externalId: z.string().min(1).max(120),
  label: z.string().min(1).max(80),
  scopes: z.array(z.string()),
  providers: z
    .array(z.string())
    .optional()
    .openapi({
      description:
        "Plugin ids. Narrows every `resources:*`, `secrets:*` and `storage:*` scope to these " +
        "providers (`resources:read` becomes `resources:<plugin>:read`). Omitted or empty means " +
        "all. With providers, every scope must be one of those families (see `narrowableScopes`).",
    }),
}).openapi("CreatePlatformAgent");

export const PatchAgent = strict({
  label: z.string().min(1).max(80).optional(),
  scopes: z.array(z.string()).optional(),
  providers: z.array(z.string()).optional(),
}).openapi("PatchPlatformAgent");

const AgentWithCredential = strict({
  agent: PlatformAgent,
  credential: z.string().openapi({ description: "`iwa_` credential, shown once." }),
}).openapi("PlatformAgentWithCredential");

export const AgentEnvelope = strict({ agent: PlatformAgent }).openapi("PlatformAgentEnvelope");

const linkSecurity = [{ agentLinkCredential: [] }];

export function registerAgentLinkPaths(ctx: BuildContext) {
  const { registry } = ctx;
  registry.registerComponent("securitySchemes", "agentLinkCredential", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "iwl_",
    description: "An agent link credential, collected once from the device flow's token poll.",
  });
  const tags = ["Agent links"];
  const idParam = z.object({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "post",
    path: "/api/agent-links/requests",
    tags,
    summary: "Start linking a platform (device flow)",
    description: "Unauthenticated, rate limited per source address.",
    security: [],
    request: { body: { content: { "application/json": { schema: LinkRequest } } } },
    responses: {
      201: {
        description: "Started",
        content: { "application/json": { schema: LinkRequestStarted } },
      },
      400: errorWith("Malformed platform, label or scopes"),
      429: errorWith("Too many requests from this address"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent-links/requests/token",
    tags,
    summary: "Poll a link request",
    security: [],
    request: {
      body: {
        content: { "application/json": { schema: strict({ deviceCode: z.string() }) } },
      },
    },
    responses: {
      200: { description: "Status", content: { "application/json": { schema: LinkPoll } } },
      429: errorWith('Polling faster than `interval`: `{ error: "slow_down" }`'),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent-links/requests/lookup",
    tags,
    summary: "Resolve a user code for the approval page",
    description:
      "Session only. A POST with the code in the body rather than a query string: the code is " +
      "a live bearer secret. Rate limited per user.",
    request: { body: { content: { "application/json": { schema: CodeBody } } } },
    responses: {
      200: { description: "Resolved", content: { "application/json": { schema: LinkLookup } } },
      400: errorWith("Malformed, unknown or expired code"),
      401: ErrorResponses[401],
      429: errorWith("Too many attempts"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent-links/requests/approve",
    tags,
    summary: "Approve a link request into an organization",
    description:
      "Session only. Needs `team:invite` in the organization; `scopes` (the ceiling) must be " +
      "within what you hold there, break-glass elevation excluded, minus permissions no agent " +
      "may hold.",
    request: { body: { content: { "application/json": { schema: ApproveBody } } } },
    responses: {
      200: { description: "Approved", content: { "application/json": { schema: Ok } } },
      400: errorWith("Bad code, or `scope_not_allowed`"),
      401: ErrorResponses[401],
      403: errorWith("You lack `team:invite` there"),
      409: errorWith("Already decided or expired"),
      429: errorWith("Too many attempts"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent-links/requests/deny",
    tags,
    summary: "Deny a link request",
    request: { body: { content: { "application/json": { schema: CodeBody } } } },
    responses: {
      200: { description: "Denied", content: { "application/json": { schema: Ok } } },
      400: errorWith("Bad code"),
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agent-link",
    tags,
    summary: "Describe this link",
    security: linkSecurity,
    responses: {
      200: { description: "The link", content: { "application/json": { schema: LinkInfo } } },
      401: errorWith("Unknown or revoked link credential"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/agent-link",
    tags,
    summary: "Unlink, revoking every agent this link made",
    security: linkSecurity,
    responses: {
      200: { description: "Revoked", content: { "application/json": { schema: Ok } } },
      401: errorWith("Unknown or revoked link credential"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agent-link/agents",
    tags,
    summary: "List the agents this link made, newest first, revoked included",
    security: linkSecurity,
    responses: {
      200: {
        description: "Agents",
        content: { "application/json": { schema: z.array(PlatformAgent) } },
      },
      401: errorWith("Unknown or revoked link credential"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent-link/agents",
    tags,
    summary: "Create an agent with its own `iwa_` credential",
    security: linkSecurity,
    request: { body: { content: { "application/json": { schema: CreateAgent } } } },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: AgentWithCredential } },
      },
      400: errorWith("`scope_not_allowed` (with `scopes`), `invalid_provider`, or malformed"),
      401: errorWith("Unknown or revoked link credential"),
      403: errorWith("The approving person no longer exists"),
      409: errorWith("`exists`: a live agent with this `externalId` (with `agentId`)"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/agent-link/agents/{id}",
    tags,
    summary: "Edit an agent's label, scopes or providers",
    security: linkSecurity,
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: PatchAgent } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: AgentEnvelope } } },
      400: errorWith("`scope_not_allowed`, `invalid_provider`, or malformed"),
      401: errorWith("Unknown or revoked link credential"),
      404: errorWith("Not an agent of this link, or revoked"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent-link/agents/{id}/rotate",
    tags,
    summary: "Replace an agent's credential; the old one stops working immediately",
    security: linkSecurity,
    request: { params: idParam },
    responses: {
      200: {
        description: "Rotated",
        content: { "application/json": { schema: AgentWithCredential } },
      },
      401: errorWith("Unknown or revoked link credential"),
      404: errorWith("Not an agent of this link, or revoked"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/agent-link/agents/{id}",
    tags,
    summary: "Revoke an agent (idempotent; the row is kept for the audit log)",
    security: linkSecurity,
    request: { params: idParam },
    responses: {
      200: { description: "Revoked", content: { "application/json": { schema: Ok } } },
      401: errorWith("Unknown or revoked link credential"),
      404: errorWith("Not an agent of this link"),
    },
  });

  const orgIdParams = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/agent-links",
    tags,
    summary: "List the platforms linked to this organization",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Links",
        content: { "application/json": { schema: z.array(OrgLinkSummary) } },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/agent-links/{id}",
    tags,
    summary: "Revoke a platform link and every agent it made",
    description: "Closed to agent credentials.",
    request: { params: orgIdParams },
    responses: {
      200: {
        description: "Revoked",
        content: {
          "application/json": {
            schema: strict({ ok: z.literal(true), revoked: z.boolean() }).openapi(
              "AgentLinkRevoked",
            ),
          },
        },
      },
      ...ErrorResponses,
    },
  });
}
