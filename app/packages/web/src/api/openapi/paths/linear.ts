import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * The detectors a filed issue can come from — the same six as Jira. Kept in
 * step with `LINEAR_SOURCE_KINDS` in server-core and the CHECK constraint on
 * `linear_issue_links.source_kind`.
 */
const LinearSourceKind = z
  .enum(["cost_anomaly", "orphan", "oversized", "posture_finding", "expiring", "probe"])
  .openapi("LinearSourceKind", {
    description: "Which detector produced the finding the issue was filed from.",
  });

const LinearIntegration = strict({
  keyHint: z.string().openapi({
    description:
      "Redacted marker for the stored personal API key, e.g. `…a7f2`. The key itself is never returned.",
    example: "…a7f2",
  }),
  defaultTeamId: z.string().nullable().openapi({
    description: "Team the file-issue window preselects. A Linear team id, not a team key.",
  }),
  updatedAt: IsoDateTime,
}).openapi("LinearIntegration");

const LinearIntegrationInput = strict({
  apiKey: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .openapi({
      description:
        "Personal API key from Linear → Settings → Security & access. Omit to keep the stored " +
        "key; required on first connect.",
    }),
  defaultTeamId: z.string().max(64).nullish(),
}).openapi("LinearIntegrationInput");

const LinearVerifyInput = strict({
  apiKey: z.string().min(1).max(1024).optional(),
}).openapi("LinearVerifyInput", {
  description:
    "Supply a key to test one that has not been saved yet; send an empty object to re-test " +
    "the stored one.",
});

const LinearVerifyResult = strict({
  ok: z.literal(true),
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
}).openapi("LinearVerifyResult", {
  description: "The Linear user behind the API key, from the `viewer` query.",
});

const LinearTeam = strict({
  id: z.string().openapi({ description: "Team id (UUID) — what issueCreate wants." }),
  key: z.string().openapi({
    description: "Short prefix issue identifiers are built from.",
    example: "ENG",
  }),
  name: z.string().openapi({ example: "Engineering" }),
}).openapi("LinearTeam");

const LinearIssueLink = strict({
  id: z.string(),
  sourceKind: LinearSourceKind,
  sourceId: z.string(),
  issueIdentifier: z.string().openapi({ example: "ENG-123" }),
  issueUrl: z.string().openapi({ example: "https://linear.app/acme/issue/ENG-123" }),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
}).openapi("LinearIssueLink");

const CreateLinearIssueInput = strict({
  sourceKind: LinearSourceKind,
  sourceId: z.string().min(1).max(512).openapi({
    description: "The finding's own id, as the detector reports it.",
  }),
  teamId: z.string().min(1).max(64).openapi({
    description: "Team to file into. Every Linear issue belongs to exactly one team.",
  }),
  title: z.string().min(1).max(255),
  description: z
    .string()
    .max(30_000)
    .optional()
    .openapi({
      description:
        "Markdown, passed to Linear as-is — unlike Jira, where the server converts plain text " +
        "to Atlassian Document Format.",
    }),
  labelIds: z.array(z.string().max(64)).max(20).optional().openapi({
    description: "Ids of existing labels in the workspace. Linear cannot create labels here.",
  }),
  projectId: z.string().max(64).optional().openapi({
    description: "Optional project to attach the issue to.",
  }),
}).openapi("CreateLinearIssueInput");

const CreateLinearIssueResult = strict({
  issue: strict({
    id: z.string(),
    identifier: z.string().openapi({ example: "ENG-123" }),
    url: z.string(),
  }),
  link: LinearIssueLink,
}).openapi("CreateLinearIssueResult");

const LinearLinksQuery = strict({
  sourceKind: LinearSourceKind.optional(),
  sourceId: z
    .array(z.string().max(512))
    .max(500)
    .optional()
    .openapi({
      description:
        "Repeat to narrow to specific findings. Omit to return every link of the kind — this is " +
        "the batch lookup a list view makes once instead of one request per row.",
    }),
});

export function registerLinearPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/linear",
    tags: ["Linear"],
    summary: "Get the org's Linear connection",
    description: "The stored API key is never returned; `keyHint` stands in for it.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The connection, or null when Linear has not been connected",
        content: {
          "application/json": {
            schema: strict({ integration: LinearIntegration.nullable() }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/linear",
    tags: ["Linear"],
    summary: "Connect Linear, or update the connection",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: LinearIntegrationInput } }, required: true },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: LinearIntegration } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/linear",
    tags: ["Linear"],
    summary: "Disconnect Linear",
    description: "Issue links already recorded are kept, so filed findings stay marked as filed.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Disconnected", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/linear/verify",
    tags: ["Linear"],
    summary: "Check Linear credentials",
    description:
      "Runs the `viewer` query against the Linear GraphQL API, so a mistyped or revoked key is " +
      "reported on the settings form rather than on the first attempt to file an issue.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: LinearVerifyInput } }, required: false },
    },
    responses: {
      200: {
        description: "The key works; the Linear user it belongs to",
        content: { "application/json": { schema: LinearVerifyResult } },
      },
      400: ErrorResponses[400],
      502: {
        description: "Linear rejected the key or was unreachable",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/linear/teams",
    tags: ["Linear"],
    summary: "List Linear teams",
    description:
      "Backs the team picker, so nobody has to know a team id by hand — issueCreate requires " +
      "one, and every issue belongs to exactly one team.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Teams visible to the stored API key",
        content: { "application/json": { schema: z.array(LinearTeam) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/linear/issues",
    tags: ["Linear"],
    summary: "File a finding as a Linear issue",
    description:
      "Creates the issue via the issueCreate mutation, then records the link between it and the " +
      'finding. The link is what lets a list view show "already filed" instead of offering the ' +
      "button again.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateLinearIssueInput } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CreateLinearIssueResult } },
      },
      400: ErrorResponses[400],
      502: {
        description: "Linear refused to create the issue, or was unreachable",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/linear/links",
    tags: ["Linear"],
    summary: "Look up filed issues for a set of findings",
    request: { params: OrgIdParam, query: LinearLinksQuery },
    responses: {
      200: {
        description: "Links, newest first",
        content: { "application/json": { schema: z.array(LinearIssueLink) } },
      },
      400: ErrorResponses[400],
    },
  });
}
