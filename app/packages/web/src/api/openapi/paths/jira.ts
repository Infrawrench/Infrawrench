import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * The detectors a filed issue can come from. Kept in step with
 * `JIRA_SOURCE_KINDS` in server-core and the CHECK constraint on
 * `jira_issue_links.source_kind`.
 */
const JiraSourceKind = z
  .enum(["cost_anomaly", "orphan", "oversized", "posture_finding", "expiring", "probe"])
  .openapi("JiraSourceKind", {
    description: "Which detector produced the finding the issue was filed from.",
  });

const JiraIntegration = strict({
  siteUrl: z.string().openapi({ example: "https://acme.atlassian.net" }),
  accountEmail: z.string().openapi({ example: "ops@acme.com" }),
  tokenHint: z.string().openapi({
    description:
      "Redacted marker for the stored API token, e.g. `…a7f2`. The token itself is never returned.",
    example: "…a7f2",
  }),
  defaultProjectKey: z.string().nullable().openapi({ example: "OPS" }),
  defaultIssueTypeId: z.string().nullable().openapi({ example: "10004" }),
  updatedAt: IsoDateTime,
}).openapi("JiraIntegration");

const JiraIntegrationInput = strict({
  siteUrl: z
    .string()
    .min(1)
    .max(255)
    .openapi({
      description:
        "Jira Cloud site address. Must resolve to a .atlassian.net (or legacy .jira.com) host; " +
        "a bare hostname and a pasted board or issue URL are both accepted and normalized.",
      example: "https://acme.atlassian.net",
    }),
  accountEmail: z.string().email().max(255).openapi({
    description: "Atlassian account email — the username half of the basic-auth pair.",
  }),
  apiToken: z.string().min(1).max(1024).optional().openapi({
    description:
      "API token from id.atlassian.com. Omit to keep the stored token; required on first connect.",
  }),
  defaultProjectKey: z.string().max(64).nullish(),
  defaultIssueTypeId: z.string().max(64).nullish(),
}).openapi("JiraIntegrationInput");

const JiraVerifyInput = strict({
  siteUrl: z.string().min(1).max(255).optional(),
  accountEmail: z.string().email().max(255).optional(),
  apiToken: z.string().min(1).max(1024).optional(),
}).openapi("JiraVerifyInput", {
  description:
    "Supply all three to test credentials that have not been saved yet; send an empty object " +
    "to re-test the stored ones.",
});

const JiraVerifyResult = strict({
  ok: z.literal(true),
  accountId: z.string(),
  displayName: z.string(),
  emailAddress: z.string().nullable(),
}).openapi("JiraVerifyResult");

const JiraProject = strict({
  id: z.string().openapi({ example: "10000" }),
  key: z.string().openapi({ example: "OPS" }),
  name: z.string().openapi({ example: "Operations" }),
}).openapi("JiraProject");

const JiraIssueType = strict({
  id: z.string().openapi({ example: "10004" }),
  name: z.string().openapi({ example: "Task" }),
  subtask: z.literal(false).openapi({
    description: "Always false — subtasks need a parent issue, so they are filtered out.",
  }),
  description: z.string().nullable(),
}).openapi("JiraIssueType");

const JiraIssueLink = strict({
  id: z.string(),
  sourceKind: JiraSourceKind,
  sourceId: z.string(),
  issueKey: z.string().openapi({ example: "OPS-412" }),
  issueUrl: z.string().openapi({ example: "https://acme.atlassian.net/browse/OPS-412" }),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
}).openapi("JiraIssueLink");

const CreateJiraIssueInput = strict({
  sourceKind: JiraSourceKind,
  sourceId: z.string().min(1).max(512).openapi({
    description: "The finding's own id, as the detector reports it.",
  }),
  projectKey: z.string().min(1).max(64).openapi({ example: "OPS" }),
  issueTypeId: z.string().min(1).max(64).openapi({ example: "10004" }),
  summary: z.string().min(1).max(255),
  description: z
    .string()
    .max(30_000)
    .optional()
    .openapi({
      description:
        "Plain text. Converted server-side to Atlassian Document Format, which is what the " +
        "Jira REST v3 description field requires; blank lines become paragraphs.",
    }),
  labels: z.array(z.string().max(255)).max(20).optional().openapi({
    description: "Whitespace inside a label is replaced with '-', since Jira rejects it.",
  }),
}).openapi("CreateJiraIssueInput");

const CreateJiraIssueResult = strict({
  issue: strict({
    id: z.string(),
    key: z.string().openapi({ example: "OPS-412" }),
    url: z.string(),
  }),
  link: JiraIssueLink,
}).openapi("CreateJiraIssueResult");

const JiraLinksQuery = strict({
  sourceKind: JiraSourceKind.optional(),
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

export function registerJiraPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const projectKeyParam = OrgIdParam.extend({
    key: z
      .string()
      .min(1)
      .max(64)
      .openapi({ param: { name: "key", in: "path" }, example: "OPS" }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jira",
    tags: ["Jira"],
    summary: "Get the org's Jira connection",
    description: "The stored API token is never returned; `tokenHint` stands in for it.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The connection, or null when Jira has not been connected",
        content: {
          "application/json": {
            schema: strict({ integration: JiraIntegration.nullable() }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/jira",
    tags: ["Jira"],
    summary: "Connect Jira, or update the connection",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: JiraIntegrationInput } }, required: true },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: JiraIntegration } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/jira",
    tags: ["Jira"],
    summary: "Disconnect Jira",
    description: "Issue links already recorded are kept, so filed findings stay marked as filed.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Disconnected", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/jira/verify",
    tags: ["Jira"],
    summary: "Check Jira credentials",
    description:
      "Calls GET /rest/api/3/myself on the site, so a wrong email or a revoked token is " +
      "reported on the settings form rather than on the first attempt to file an issue.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: JiraVerifyInput } }, required: false },
    },
    responses: {
      200: {
        description: "Credentials work; the account they belong to",
        content: { "application/json": { schema: JiraVerifyResult } },
      },
      400: ErrorResponses[400],
      502: {
        description: "Jira rejected the credentials or was unreachable",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jira/projects",
    tags: ["Jira"],
    summary: "List Jira projects",
    description: "Backs the project picker, so nobody has to know a project key by hand.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Projects visible to the stored account, key-sorted",
        content: { "application/json": { schema: z.array(JiraProject) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jira/projects/{key}/issue-types",
    tags: ["Jira"],
    summary: "List issue types valid in a project",
    description:
      "Reads the project's own create metadata rather than the global issue-type list, so the " +
      "picker cannot offer a type the project's scheme would reject. Subtasks are excluded.",
    request: { params: projectKeyParam },
    responses: {
      200: {
        description: "Issue types",
        content: { "application/json": { schema: z.array(JiraIssueType) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/jira/issues",
    tags: ["Jira"],
    summary: "File a finding as a Jira issue",
    description:
      "Creates the issue, then records the link between it and the finding. The link is what " +
      'lets a list view show "already filed" instead of offering the button again.',
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateJiraIssueInput } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CreateJiraIssueResult } },
      },
      400: ErrorResponses[400],
      502: {
        description: "Jira refused to create the issue, or was unreachable",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jira/links",
    tags: ["Jira"],
    summary: "Look up filed issues for a set of findings",
    request: { params: OrgIdParam, query: JiraLinksQuery },
    responses: {
      200: {
        description: "Links, newest first",
        content: { "application/json": { schema: z.array(JiraIssueLink) } },
      },
      400: ErrorResponses[400],
    },
  });
}
