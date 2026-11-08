/**
 * The browser half of the Slack install, `/api/slack/oauth/*`, the endpoint
 * definitions. Outside the org tree; the org-scoped half (status, the "Add to
 * Slack" URL, channels) is the `slack` domain, whose `install-url` mints the
 * signed `state` these hops check.
 *
 * Both are browser redirects, never called by an API client, and the
 * hand-written spec never documented them, so they stay out of the document.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { withApiDefaults } from "../../domain";
import { undecodedQuery } from "../../schemas/raw-query";

export class SlackOAuthGroup extends HttpApiGroup.make("slackOAuth")
  .add(
    HttpApiEndpoint.get("start", "/start", {
      query: { state: undecodedQuery(Schema.String) },
      success: HttpApiSchema.Empty(302),
    }).annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("callback", "/callback", {
      query: {
        state: undecodedQuery(Schema.String),
        code: undecodedQuery(Schema.String),
        error: undecodedQuery(Schema.String),
      },
      success: HttpApiSchema.Empty(302),
    }).annotate(OpenApi.Exclude, true),
  )
  .prefix("/api/slack/oauth")
  .annotate(OpenApi.Title, "Slack") {}

export class SlackOAuthApi extends withApiDefaults(
  HttpApi.make("slackOAuth").add(SlackOAuthGroup),
) {}
