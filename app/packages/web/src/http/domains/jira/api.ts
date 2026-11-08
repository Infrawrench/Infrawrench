/**
 * Jira issue tracking: `/api/org/:orgId/jira`, the endpoint definitions.
 *
 * Turns a finding (cost anomaly, orphan, oversized resource, posture finding,
 * expiring credential, failed probe, ...) into a Jira issue and keeps the link,
 * so a list view shows "already filed" instead of offering the button again.
 * The org's API token is a bearer credential for a whole Atlassian account: it
 * is stored encrypted and no response carries it (`tokenHint` stands in).
 *
 * `jira:read` covers the redacted connection, the pickers, the links and the
 * status refresh; `jira:write` covers configuring the credential, the webhook
 * and filing. The inbound webhook (`/api/issue-webhooks/jira/:token`) is
 * public and lives in its own domain (`issue-webhooks`).
 */
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { JIRA_SOURCE_KINDS } from "@infrawrench/client-core";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadGateway, BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgParams } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import {
  IssueStatusRefreshResult,
  IssueWebhookSetupResult,
  IssueWebhookState,
  isEmail,
  issueStatusFields,
} from "../../schemas/issue-status";

/** Kept in step with server-core and the CHECK on `jira_issue_links.source_kind`. */
const JiraSourceKind = Schema.Literals(JIRA_SOURCE_KINDS).annotate({
  identifier: "JiraSourceKind",
  description: "Which detector produced the finding the issue was filed from.",
});

const JiraIntegration = Schema.Struct({
  siteUrl: Schema.String.annotate({ examples: ["https://acme.atlassian.net"] }),
  accountEmail: Schema.String.annotate({ examples: ["ops@acme.com"] }),
  tokenHint: Schema.String.annotate({
    description:
      "Redacted marker for the stored API token, e.g. `…a7f2`. The token itself is never returned.",
    examples: ["…a7f2"],
  }),
  defaultProjectKey: Schema.NullOr(Schema.String).annotate({ examples: ["OPS"] }),
  defaultIssueTypeId: Schema.NullOr(Schema.String).annotate({ examples: ["10004"] }),
  acknowledgeOnDone: Schema.Boolean.annotate({
    description:
      "When an issue filed for a cost anomaly moves to done, record the anomaly as explained.",
  }),
  webhook: IssueWebhookState,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "JiraIntegration" });

export const JiraIntegrationResponse = Schema.Struct({
  integration: Schema.NullOr(JiraIntegration),
});
export { JiraIntegration };

const SiteUrl = Schema.String.check(minLength(1), maxLength(255));
const AccountEmail = Schema.String.check(isEmail, maxLength(255));
const ApiToken = Schema.String.check(minLength(1), maxLength(1024));

const JiraIntegrationInput = Schema.Struct({
  siteUrl: SiteUrl.annotate({
    description:
      "Jira Cloud site address. Must resolve to a .atlassian.net (or legacy .jira.com) host; " +
      "a bare hostname and a pasted board or issue URL are both accepted and normalized.",
    examples: ["https://acme.atlassian.net"],
  }),
  accountEmail: AccountEmail.annotate({
    description: "Atlassian account email; the username half of the basic-auth pair.",
  }),
  apiToken: Schema.optionalKey(
    ApiToken.annotate({
      description:
        "API token from id.atlassian.com. Omit to keep the stored token; required on first connect.",
    }),
  ),
  defaultProjectKey: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(64)))),
  defaultIssueTypeId: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(64)))),
  acknowledgeOnDone: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Omit to keep the stored value (off on first connect).",
    }),
  ),
}).annotate({ identifier: "JiraIntegrationInput" });

export const JiraVerifyInput = Schema.Struct({
  siteUrl: Schema.optionalKey(SiteUrl),
  accountEmail: Schema.optionalKey(AccountEmail),
  apiToken: Schema.optionalKey(ApiToken),
}).annotate({
  identifier: "JiraVerifyInput",
  description:
    "Supply all three to test credentials that have not been saved yet; send an empty object " +
    "to re-test the stored ones.",
});

export const JiraVerifyResult = Schema.Struct({
  ok: Schema.Literal(true),
  accountId: Schema.String,
  displayName: Schema.String,
  emailAddress: Schema.NullOr(Schema.String),
}).annotate({ identifier: "JiraVerifyResult" });

const JiraProject = Schema.Struct({
  id: Schema.String.annotate({ examples: ["10000"] }),
  key: Schema.String.annotate({ examples: ["OPS"] }),
  name: Schema.String.annotate({ examples: ["Operations"] }),
}).annotate({ identifier: "JiraProject" });
export const JiraProjects = Schema.Array(JiraProject);

const JiraIssueType = Schema.Struct({
  id: Schema.String.annotate({ examples: ["10004"] }),
  name: Schema.String.annotate({ examples: ["Task"] }),
  subtask: Schema.Literal(false).annotate({
    description: "Always false: subtasks need a parent issue, so they are filtered out.",
  }),
  description: Schema.NullOr(Schema.String),
}).annotate({ identifier: "JiraIssueType" });
export const JiraIssueTypes = Schema.Array(JiraIssueType);

const JiraIssueLink = Schema.Struct({
  id: Schema.String,
  sourceKind: JiraSourceKind,
  sourceId: Schema.String,
  issueKey: Schema.String.annotate({ examples: ["OPS-412"] }),
  issueUrl: Schema.String.annotate({ examples: ["https://acme.atlassian.net/browse/OPS-412"] }),
  ...issueStatusFields,
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
}).annotate({ identifier: "JiraIssueLink" });
export const JiraIssueLinks = Schema.Array(JiraIssueLink);

const CreateJiraIssueInput = Schema.Struct({
  sourceKind: JiraSourceKind,
  sourceId: Schema.String.check(minLength(1), maxLength(512)).annotate({
    description: "The finding's own id, as the detector reports it.",
  }),
  projectKey: Schema.String.check(minLength(1), maxLength(64)).annotate({ examples: ["OPS"] }),
  issueTypeId: Schema.String.check(minLength(1), maxLength(64)).annotate({
    examples: ["10004"],
  }),
  summary: Schema.String.check(minLength(1), maxLength(255)),
  description: Schema.optionalKey(
    Schema.String.check(maxLength(30_000)).annotate({
      description:
        "Plain text. Converted server-side to Atlassian Document Format, which is what the " +
        "Jira REST v3 description field requires; blank lines become paragraphs.",
    }),
  ),
  labels: Schema.optionalKey(
    Schema.Array(Schema.String.check(maxLength(255)))
      .check(maxLength(20))
      .annotate({
        description: "Whitespace inside a label is replaced with '-', since Jira rejects it.",
      }),
  ),
}).annotate({ identifier: "CreateJiraIssueInput" });

export const CreateJiraIssueResult = Schema.Struct({
  issue: Schema.Struct({
    id: Schema.String,
    key: Schema.String.annotate({ examples: ["OPS-412"] }),
    url: Schema.String,
  }),
  link: JiraIssueLink,
}).annotate({ identifier: "CreateJiraIssueResult" });

export const JiraWebhookInput = Schema.Struct({
  mode: Schema.Literals(["auto", "manual"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("auto" as const)),
  ),
}).annotate({ identifier: "JiraWebhookInput" });

export class JiraGroup extends HttpApiGroup.make("jira")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      success: JiraIntegrationResponse,
    })
      .annotate(RequiredPermission, "jira:read")
      .annotate(OpenApi.Summary, "Get the org's Jira connection")
      .annotate(
        OpenApi.Description,
        "The stored API token is never returned; `tokenHint` stands in for it.",
      )
      .annotate(SuccessDescription, "The connection, or null when Jira has not been connected"),
    HttpApiEndpoint.put("configure", "/", {
      params: OrgParams,
      payload: JiraIntegrationInput,
      success: JiraIntegration,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "jira:write")
      .annotate(OpenApi.Summary, "Connect Jira, or update the connection")
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid Jira settings"),
    HttpApiEndpoint.delete("disconnect", "/", {
      params: OrgParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "jira:write")
      .annotate(OpenApi.Summary, "Disconnect Jira")
      .annotate(
        OpenApi.Description,
        "Issue links already recorded are kept, so filed findings stay marked as filed.",
      )
      .annotate(SuccessDescription, "Disconnected"),
    // An empty or unreadable body re-tests the stored credentials.
    HttpApiEndpoint.post("verify", "/verify", {
      params: OrgParams,
      payload: JiraVerifyInput,
      success: JiraVerifyResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "jira:write")
      .annotate(OpenApi.Summary, "Check Jira credentials")
      .annotate(
        OpenApi.Description,
        "Calls GET /rest/api/3/myself on the site, so a wrong email or a revoked token is " +
          "reported on the settings form rather than on the first attempt to file an issue.",
      )
      .annotate(SuccessDescription, "Credentials work; the account they belong to")
      .annotate(InvalidRequestMessage, "Invalid Jira credentials")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("projects", "/projects", {
      params: OrgParams,
      success: JiraProjects,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "jira:read")
      .annotate(OpenApi.Summary, "List Jira projects")
      .annotate(
        OpenApi.Description,
        "Backs the project picker, so nobody has to know a project key by hand.",
      )
      .annotate(SuccessDescription, "Projects visible to the stored account, key-sorted"),
    HttpApiEndpoint.get("issueTypes", "/projects/:key/issue-types", {
      params: { ...OrgParams, key: Schema.String.annotate({ examples: ["OPS"] }) },
      success: JiraIssueTypes,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "jira:read")
      .annotate(OpenApi.Summary, "List issue types valid in a project")
      .annotate(
        OpenApi.Description,
        "Reads the project's own create metadata rather than the global issue-type list, so the " +
          "picker cannot offer a type the project's scheme would reject. Subtasks are excluded.",
      )
      .annotate(SuccessDescription, "Issue types"),
    HttpApiEndpoint.post("fileIssue", "/issues", {
      params: OrgParams,
      payload: CreateJiraIssueInput,
      success: CreateJiraIssueResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "jira:write")
      .annotate(OpenApi.Summary, "File a finding as a Jira issue")
      .annotate(
        OpenApi.Description,
        "Creates the issue, then records the link between it and the finding. The link is what " +
          'lets a list view show "already filed" instead of offering the button again.',
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid issue"),
    HttpApiEndpoint.get("links", "/links", {
      params: OrgParams,
      query: {
        sourceKind: Schema.optionalKey(JiraSourceKind),
        sourceId: Schema.optionalKey(
          Schema.Array(Schema.String.check(maxLength(512)))
            .check(maxLength(500))
            .annotate({
              description:
                "Repeat to narrow to specific findings. Omit to return every link of the kind; this is " +
                "the batch lookup a list view makes once instead of one request per row.",
            }),
        ),
      },
      success: JiraIssueLinks,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "jira:read")
      .annotate(OpenApi.Summary, "Look up filed issues for a set of findings")
      .annotate(SuccessDescription, "Links, newest first")
      .annotate(InvalidRequestMessage, "Invalid link filter"),
    // An empty or unreadable body means `auto`.
    HttpApiEndpoint.post("setupWebhook", "/webhook", {
      params: OrgParams,
      payload: JiraWebhookInput,
      success: IssueWebhookSetupResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "jira:write")
      .annotate(OpenApi.Summary, "Set up the issue status webhook")
      .annotate(
        OpenApi.Description,
        "`auto` (the default) registers a webhook in Jira for `jira:issue_updated` and `jira:issue_deleted` through the stored account, which Jira allows for administrators only. When Jira refuses, the reply falls back to manual and carries the URL and a one-time `secret` for an administrator to paste into Jira's webhook form. `manual` skips the attempt. Replaces any webhook set up before.",
      )
      .annotate(SuccessDescription, "The webhook as it now stands")
      .annotate(InvalidRequestMessage, "Invalid webhook request")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("removeWebhook", "/webhook", {
      params: OrgParams,
      success: Ok,
      error: [BadRequest, NotFound, BadGateway],
    })
      .annotate(RequiredPermission, "jira:write")
      .annotate(OpenApi.Summary, "Remove the issue status webhook")
      .annotate(
        OpenApi.Description,
        "Deletes the webhook in Jira when Infrawrench registered it. Statuses keep refreshing through the poll.",
      )
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.post("refreshLinks", "/links/refresh", {
      params: OrgParams,
      success: IssueStatusRefreshResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "jira:read")
      .annotate(OpenApi.Summary, "Refresh the status of filed Jira issues now")
      .annotate(
        OpenApi.Description,
        "Reads up to 200 of the org's filed issues from Jira (least recently checked first) instead of waiting for a webhook or the poll.",
      )
      .annotate(SuccessDescription, "How many were checked and changed"),
  )
  .prefix("/api/org/:orgId/jira")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Jira") {}

export class JiraApi extends withApiDefaults(HttpApi.make("jira").add(JiraGroup)) {}
