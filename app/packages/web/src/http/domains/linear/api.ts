/**
 * Linear issue tracking: `/api/org/:orgId/linear`, the endpoint definitions.
 *
 * The second tracker beside Jira, over the same contract shape: file a
 * finding as a Linear issue and keep the link. The org's personal API key is
 * a bearer credential for everything its Linear user can see: stored
 * encrypted and never returned (`keyHint` stands in). The same permission
 * split as Jira: `linear:read` for the connection, the team picker, the links
 * and the status refresh, `linear:write` for the key, the webhook and filing.
 */
import { Schema } from "effect";
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
  issueStatusFields,
} from "../../schemas/issue-status";

/** The same kinds as Jira (`LinearSourceKind` is `JiraSourceKind` in client-core). */
const LinearSourceKind = Schema.Literals(JIRA_SOURCE_KINDS).annotate({
  identifier: "LinearSourceKind",
  description: "Which detector produced the finding the issue was filed from.",
});

export const LinearIntegration = Schema.Struct({
  keyHint: Schema.String.annotate({
    description:
      "Redacted marker for the stored personal API key, e.g. `…a7f2`. The key itself is never returned.",
    examples: ["…a7f2"],
  }),
  defaultTeamId: Schema.NullOr(Schema.String).annotate({
    description: "Team the file-issue window preselects. A Linear team id, not a team key.",
  }),
  acknowledgeOnDone: Schema.Boolean.annotate({
    description:
      "When an issue filed for a cost anomaly moves to done, record the anomaly as explained.",
  }),
  webhook: IssueWebhookState,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "LinearIntegration" });

export const LinearIntegrationResponse = Schema.Struct({
  integration: Schema.NullOr(LinearIntegration),
});

const ApiKey = Schema.String.check(minLength(1), maxLength(1024));

const LinearIntegrationInput = Schema.Struct({
  apiKey: Schema.optionalKey(
    ApiKey.annotate({
      description:
        "Personal API key from Linear → Settings → Security & access. Omit to keep the stored " +
        "key; required on first connect.",
    }),
  ),
  defaultTeamId: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(64)))),
  acknowledgeOnDone: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Omit to keep the stored value (off on first connect).",
    }),
  ),
}).annotate({ identifier: "LinearIntegrationInput" });

export const LinearVerifyInput = Schema.Struct({
  apiKey: Schema.optionalKey(ApiKey),
}).annotate({
  identifier: "LinearVerifyInput",
  description:
    "Supply a key to test one that has not been saved yet; send an empty object to re-test " +
    "the stored one.",
});

export const LinearVerifyResult = Schema.Struct({
  ok: Schema.Literal(true),
  id: Schema.String,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
}).annotate({
  identifier: "LinearVerifyResult",
  description: "The Linear user behind the API key, from the `viewer` query.",
});

const LinearTeam = Schema.Struct({
  id: Schema.String.annotate({ description: "Team id (UUID), what issueCreate wants." }),
  key: Schema.String.annotate({
    description: "Short prefix issue identifiers are built from.",
    examples: ["ENG"],
  }),
  name: Schema.String.annotate({ examples: ["Engineering"] }),
}).annotate({ identifier: "LinearTeam" });
export const LinearTeams = Schema.Array(LinearTeam);

const LinearIssueLink = Schema.Struct({
  id: Schema.String,
  sourceKind: LinearSourceKind,
  sourceId: Schema.String,
  issueIdentifier: Schema.String.annotate({ examples: ["ENG-123"] }),
  issueUrl: Schema.String.annotate({ examples: ["https://linear.app/acme/issue/ENG-123"] }),
  ...issueStatusFields,
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
}).annotate({ identifier: "LinearIssueLink" });
export const LinearIssueLinks = Schema.Array(LinearIssueLink);

const CreateLinearIssueInput = Schema.Struct({
  sourceKind: LinearSourceKind,
  sourceId: Schema.String.check(minLength(1), maxLength(512)).annotate({
    description: "The finding's own id, as the detector reports it.",
  }),
  teamId: Schema.String.check(minLength(1), maxLength(64)).annotate({
    description: "Team to file into. Every Linear issue belongs to exactly one team.",
  }),
  title: Schema.String.check(minLength(1), maxLength(255)),
  description: Schema.optionalKey(
    Schema.String.check(maxLength(30_000)).annotate({
      description:
        "Markdown, passed to Linear as-is; unlike Jira, where the server converts plain text " +
        "to Atlassian Document Format.",
    }),
  ),
  labelIds: Schema.optionalKey(
    Schema.Array(Schema.String.check(maxLength(64)))
      .check(maxLength(20))
      .annotate({
        description: "Ids of existing labels in the workspace. Linear cannot create labels here.",
      }),
  ),
  projectId: Schema.optionalKey(
    Schema.String.check(maxLength(64)).annotate({
      description: "Optional project to attach the issue to.",
    }),
  ),
}).annotate({ identifier: "CreateLinearIssueInput" });

export const CreateLinearIssueResult = Schema.Struct({
  issue: Schema.Struct({
    id: Schema.String,
    identifier: Schema.String.annotate({ examples: ["ENG-123"] }),
    url: Schema.String,
  }),
  link: LinearIssueLink,
}).annotate({ identifier: "CreateLinearIssueResult" });

export const LinearWebhookInput = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("auto") }),
  Schema.Struct({
    mode: Schema.Literal("manual"),
    signingSecret: Schema.String.check(minLength(1), maxLength(512)),
  }),
]).annotate({ identifier: "LinearWebhookInput" });

export const LinearWebhookUrl = Schema.Struct({ url: Schema.String });

export class LinearGroup extends HttpApiGroup.make("linear")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      success: LinearIntegrationResponse,
    })
      .annotate(RequiredPermission, "linear:read")
      .annotate(OpenApi.Summary, "Get the org's Linear connection")
      .annotate(
        OpenApi.Description,
        "The stored API key is never returned; `keyHint` stands in for it.",
      )
      .annotate(SuccessDescription, "The connection, or null when Linear has not been connected"),
    HttpApiEndpoint.put("configure", "/", {
      params: OrgParams,
      payload: LinearIntegrationInput,
      success: LinearIntegration,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "linear:write")
      .annotate(OpenApi.Summary, "Connect Linear, or update the connection")
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid Linear settings"),
    HttpApiEndpoint.delete("disconnect", "/", {
      params: OrgParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "linear:write")
      .annotate(OpenApi.Summary, "Disconnect Linear")
      .annotate(
        OpenApi.Description,
        "Issue links already recorded are kept, so filed findings stay marked as filed.",
      )
      .annotate(SuccessDescription, "Disconnected"),
    // An empty or unreadable body re-tests the stored key.
    HttpApiEndpoint.post("verify", "/verify", {
      params: OrgParams,
      payload: LinearVerifyInput,
      success: LinearVerifyResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "linear:write")
      .annotate(OpenApi.Summary, "Check Linear credentials")
      .annotate(
        OpenApi.Description,
        "Runs the `viewer` query against the Linear GraphQL API, so a mistyped or revoked key is " +
          "reported on the settings form rather than on the first attempt to file an issue.",
      )
      .annotate(SuccessDescription, "The key works; the Linear user it belongs to")
      .annotate(InvalidRequestMessage, "Invalid Linear credentials")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("teams", "/teams", {
      params: OrgParams,
      success: LinearTeams,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "linear:read")
      .annotate(OpenApi.Summary, "List Linear teams")
      .annotate(
        OpenApi.Description,
        "Backs the team picker, so nobody has to know a team id by hand; issueCreate requires " +
          "one, and every issue belongs to exactly one team.",
      )
      .annotate(SuccessDescription, "Teams visible to the stored API key"),
    HttpApiEndpoint.post("fileIssue", "/issues", {
      params: OrgParams,
      payload: CreateLinearIssueInput,
      success: CreateLinearIssueResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "linear:write")
      .annotate(OpenApi.Summary, "File a finding as a Linear issue")
      .annotate(
        OpenApi.Description,
        "Creates the issue via the issueCreate mutation, then records the link between it and the " +
          'finding. The link is what lets a list view show "already filed" instead of offering the ' +
          "button again.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid issue"),
    HttpApiEndpoint.get("links", "/links", {
      params: OrgParams,
      query: {
        sourceKind: Schema.optionalKey(LinearSourceKind),
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
      success: LinearIssueLinks,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "linear:read")
      .annotate(OpenApi.Summary, "Look up filed issues for a set of findings")
      .annotate(SuccessDescription, "Links, newest first")
      .annotate(InvalidRequestMessage, "Invalid link filter"),
    HttpApiEndpoint.post("setupWebhook", "/webhook", {
      params: OrgParams,
      payload: LinearWebhookInput,
      success: IssueWebhookSetupResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "linear:write")
      .annotate(OpenApi.Summary, "Set up the issue status webhook")
      .annotate(
        OpenApi.Description,
        "`auto` creates a webhook in Linear for `Issue` events on all public teams, signed with a secret Infrawrench generates (Linear allows this for workspace admins only). `manual` records a webhook somebody created in Linear's settings at the URL from `POST /linear/webhook/url`, with the signing secret Linear showed them. Replaces any webhook set up before.",
      )
      .annotate(SuccessDescription, "The webhook as it now stands")
      .annotate(InvalidRequestMessage, "Invalid webhook request"),
    HttpApiEndpoint.post("webhookUrl", "/webhook/url", {
      params: OrgParams,
      success: LinearWebhookUrl,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "linear:write")
      .annotate(OpenApi.Summary, "Get the receiver URL for a hand-made Linear webhook")
      .annotate(
        OpenApi.Description,
        "Linear shows a webhook's signing secret only after it exists, so the URL comes first; record the secret afterwards with `POST /linear/webhook` in `manual` mode.",
      )
      .annotate(SuccessDescription, "The URL to paste into Linear"),
    HttpApiEndpoint.delete("removeWebhook", "/webhook", {
      params: OrgParams,
      success: Ok,
      error: [BadRequest, NotFound, BadGateway],
    })
      .annotate(RequiredPermission, "linear:write")
      .annotate(OpenApi.Summary, "Remove the issue status webhook")
      .annotate(
        OpenApi.Description,
        "Deletes the webhook in Linear when Infrawrench created it. Statuses keep refreshing through the poll.",
      )
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.post("refreshLinks", "/links/refresh", {
      params: OrgParams,
      success: IssueStatusRefreshResult,
      error: [BadRequest, BadGateway],
    })
      .annotate(RequiredPermission, "linear:read")
      .annotate(OpenApi.Summary, "Refresh the status of filed Linear issues now")
      .annotate(
        OpenApi.Description,
        "Reads up to 200 of the org's filed issues from Linear (least recently checked first) instead of waiting for a webhook or the poll.",
      )
      .annotate(SuccessDescription, "How many were checked and changed"),
  )
  .prefix("/api/org/:orgId/linear")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Linear") {}

export class LinearApi extends withApiDefaults(HttpApi.make("linear").add(LinearGroup)) {}
