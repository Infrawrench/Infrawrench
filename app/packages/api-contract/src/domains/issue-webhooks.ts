/**
 * Inbound tracker webhooks for live issue status, the endpoint definitions.
 *
 *   POST /api/issue-webhooks/jira/:token    `X-Hub-Signature: sha256=<hex>` with
 *                                           the org's stored secret
 *   POST /api/issue-webhooks/linear/:token  `Linear-Signature: <hex>` with the
 *                                           org's stored secret, plus the
 *                                           one-minute `webhookTimestamp` check
 *   POST /api/issue-webhooks/github         `X-Hub-Signature-256: sha256=<hex>`
 *                                           with `GITHUB_APP_WEBHOOK_SECRET`,
 *                                           the GitHub App's one webhook
 *
 * No session: the signature is the authentication, computed over the raw
 * body, which each handler reads itself (`handleRaw`). One group per tracker,
 * filed under the tag that tracker's other routes use.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { InternalServerError, NotFound, Unauthorized } from "../http/errors";
import { describeResponse } from "../http/schemas/documented";

const Applied = HttpApiSchema.Accepted.annotate({ description: "Applied" });

const errors = [Unauthorized, NotFound, InternalServerError] as const;

/** The descriptions the hand-written spec gave each refusal, shared by all three. */
const describeRefusals = (operation: Record<string, unknown>): Record<string, unknown> =>
  describeResponse(
    500,
    "Processing failed; the tracker retries",
  )(
    describeResponse(
      404,
      "Unknown token, or (GitHub) no webhook secret configured on the server",
    )(describeResponse(401, "The signature did not verify")(operation)),
  );

export class JiraIssueWebhookGroup extends HttpApiGroup.make("jiraIssueWebhook")
  .add(
    HttpApiEndpoint.post("receive", "/api/issue-webhooks/jira/:token", {
      params: { token: Schema.String },
      success: Applied,
      error: errors,
    })
      .annotate(OpenApi.Summary, "Inbound Jira webhook for issue status")
      .annotate(
        OpenApi.Description,
        "Called by Jira, not by clients. The token in the path picks the organization; `X-Hub-Signature: sha256=<hex>`, an HMAC of the raw body with the stored secret, authenticates the delivery. Handles `jira:issue_updated` and `jira:issue_deleted`.",
      )
      .annotate(Security, [])
      .annotate(OpenApi.Transform, describeRefusals),
  )
  .annotate(OpenApi.Title, "Jira") {}

export class LinearIssueWebhookGroup extends HttpApiGroup.make("linearIssueWebhook")
  .add(
    HttpApiEndpoint.post("receive", "/api/issue-webhooks/linear/:token", {
      params: { token: Schema.String },
      success: Applied,
      error: errors,
    })
      .annotate(OpenApi.Summary, "Inbound Linear webhook for issue status")
      .annotate(
        OpenApi.Description,
        "Called by Linear, not by clients. The token in the path picks the organization; `Linear-Signature` (hex HMAC-SHA256 of the raw body) authenticates the delivery, and `webhookTimestamp` must be within a minute. Handles `Issue` create, update and remove.",
      )
      .annotate(Security, [])
      .annotate(OpenApi.Transform, describeRefusals),
  )
  .annotate(OpenApi.Title, "Linear") {}

/** The answer to GitHub's `ping`, sent when the App's webhook is saved. */
export const PingAcknowledged = Schema.Struct({ ok: Schema.Literal(true) });

export class GithubIssueWebhookGroup extends HttpApiGroup.make("githubIssueWebhook")
  .add(
    HttpApiEndpoint.post("receive", "/api/issue-webhooks/github", {
      success: [PingAcknowledged, Applied],
      error: errors,
    })
      .annotate(OpenApi.Summary, "Inbound GitHub App webhook for issue status")
      .annotate(
        OpenApi.Description,
        "The GitHub App's webhook URL. `X-Hub-Signature-256` is verified with the server's `GITHUB_APP_WEBHOOK_SECRET`; `issues` events update the status of filed issues and `ping` is acknowledged. Every other event is ignored.",
      )
      .annotate(Security, [])
      .annotate(OpenApi.Transform, (operation) =>
        describeResponse(200, "Ping acknowledged")(describeRefusals(operation)),
      ),
  )
  .annotate(OpenApi.Title, "GitHub issues") {}

export class IssueWebhooksApi extends withApiDefaults(
  HttpApi.make("issueWebhooks")
    .add(JiraIssueWebhookGroup)
    .add(LinearIssueWebhookGroup)
    .add(GithubIssueWebhookGroup),
) {}
