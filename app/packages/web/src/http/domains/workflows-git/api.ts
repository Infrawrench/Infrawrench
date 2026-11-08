/**
 * The public git webhook for workflows, `POST /api/workflows/git/:token`, the
 * endpoint definition.
 *
 * No session: git providers (GitHub, GitLab, Bitbucket, ...) POST here with
 * nothing but the workflow's opaque `webhookToken` in the path, plus, when the
 * workflow has a signing secret, a signature over the raw body. The handler
 * reads that body itself (`handleRaw`). Never in the published spec, as the
 * Hono route was not.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { withApiDefaults } from "../../domain";
import { NotFound, Unauthorized } from "../../errors";

export class WorkflowGitWebhookGroup extends HttpApiGroup.make("workflowGitWebhook")
  .add(
    HttpApiEndpoint.post("receive", "/api/workflows/git/:token", {
      params: { token: Schema.String },
      success: Schema.Unknown,
      error: [Unauthorized, NotFound],
    }),
  )
  .annotate(OpenApi.Exclude, true) {}

export class WorkflowGitWebhookApi extends withApiDefaults(
  HttpApi.make("workflowGitWebhook").add(WorkflowGitWebhookGroup),
) {}
