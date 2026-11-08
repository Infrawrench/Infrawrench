/**
 * Inbound Slack, the endpoint definitions. Public: mounted outside every auth
 * layer, internal in the published spec (`openapi/public-spec.ts`), since
 * Slack and a browser call them, never an API client.
 *
 *  - `POST /api/slack/commands`: the `/infrawrench` slash command.
 *  - `POST /api/slack/interactions`: `block_actions` payloads from the buttons.
 *  - `GET` + `POST /api/slack/link`: the browser half of account linking,
 *    session-authed in the handler (it bounces through sign-in).
 *
 * Slack signs the exact bytes it sends, so the two Slack endpoints read the
 * body themselves (`handleRaw`); the payloads and headers here only document
 * what arrives, and nothing is decoded ahead of the signature check.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { Unauthorized } from "../../errors";
import { describeResponse, requiredHeaders, requiredQuery } from "../../schemas/documented";
import { undecodedQuery } from "../../schemas/raw-query";

const SlackSignatureHeaders = Schema.Struct({
  "x-slack-signature": Schema.optionalKey(
    Schema.String.annotate({
      description: "v0=<hex HMAC-SHA256 of `v0:<timestamp>:<raw body>`>",
    }),
  ),
  "x-slack-request-timestamp": Schema.optionalKey(
    Schema.String.annotate({
      description: "Unix seconds; requests older than 5 minutes are rejected",
    }),
  ),
});

/**
 * An `OpenApi.Transform` marking the signature headers required: decoded as
 * optional, so a request without them reaches the signature check's own 401.
 */
const requireSignatureHeaders = requiredHeaders(["x-slack-signature", "x-slack-request-timestamp"]);

const formBody = (description: string) =>
  Schema.Any.annotate({ description }).pipe(HttpApiSchema.asFormUrlEncoded());

const LinkForm = Schema.Struct({
  token: Schema.String.annotate({ description: "Signed link token from Slack (15-minute TTL)" }),
  csrf: Schema.String.annotate({
    description: "CSRF value matching the slack_link_csrf cookie",
  }),
}).pipe(HttpApiSchema.asFormUrlEncoded());

const ConfirmationPage = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" }));

export class SlackInboundGroup extends HttpApiGroup.make("slackInbound")
  .add(
    HttpApiEndpoint.post("commands", "/commands", {
      headers: SlackSignatureHeaders,
      payload: formBody("Slack's slash-command form payload"),
      success: HttpApiSchema.Empty(200),
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "Slack slash-command endpoint (/infrawrench)")
      .annotate(
        OpenApi.Description,
        "Public; verified against the app's signing secret. Handles `costs`, `status <resource>`, `link`, `unlink` and `help`. Acknowledged immediately; the ephemeral reply is delivered through the payload's `response_url`. The Slack user must have linked their account (`/infrawrench link`) and hold the same permission the equivalent web surface requires (`costs:read`, `resources:read`).",
      )
      .annotate(Security, [])
      .annotate(OpenApi.Transform, (operation) =>
        describeResponse(
          200,
          "Acknowledged; the reply is delivered through response_url",
        )(requireSignatureHeaders(operation)),
      ),
    HttpApiEndpoint.post("interactions", "/interactions", {
      headers: SlackSignatureHeaders,
      payload: formBody("`payload=<JSON>` interaction envelope from Slack"),
      success: HttpApiSchema.Empty(200),
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "Slack interactivity endpoint (Approve/Deny buttons)")
      .annotate(
        OpenApi.Description,
        "Public; verified against the app's signing secret. Receives `block_actions` payloads from the Approve/Deny buttons on approval messages and the status disambiguation picker. Button decisions resolve through the same code path as the web UI; the linked member needs `workflows:approve` (workflow approvals) or must own the conversation and hold `chat:write` (chat agent tool approvals).",
      )
      .annotate(Security, [])
      .annotate(OpenApi.Transform, (operation) =>
        describeResponse(
          200,
          "Acknowledged; feedback rides response_url and message updates",
        )(requireSignatureHeaders(operation)),
      ),
    HttpApiEndpoint.get("linkPage", "/link", {
      query: {
        token: undecodedQuery(
          Schema.String.annotate({ description: "Signed link token from Slack (15-minute TTL)" }),
        ),
      },
      success: [ConfirmationPage, HttpApiSchema.Empty(302)],
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "Confirm linking a Slack user to the signed-in member (browser)")
      .annotate(
        OpenApi.Description,
        "Landing for the signed link URL the slash-command endpoints hand to unknown Slack users. Requires a browser session (bounces through sign-in), verifies the short-lived token and membership of the token's organization, then renders a confirmation page naming the Slack user and organization. The write itself happens in the CSRF-guarded POST the page submits.",
      )
      .annotate(Security, [])
      .annotate(OpenApi.Transform, (operation) =>
        describeResponse(
          200,
          "Confirmation page (HTML form that POSTs back to this path)",
        )(
          describeResponse(
            302,
            "Redirect to sign-in or an error toast",
          )(requiredQuery(["token"])(operation)),
        ),
      ),
    HttpApiEndpoint.post("link", "/link", {
      payload: LinkForm,
      success: HttpApiSchema.Empty(302),
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "Store the Slack-user ↔ member link (confirmation form target)")
      .annotate(
        OpenApi.Description,
        "Submitted by the confirmation page above. Requires the browser session, the signed link token, and the double-submit CSRF pair (cookie + form field) minted by the GET; on success stores the Slack-user ↔ member mapping and redirects to the notification settings page.",
      )
      .annotate(Security, [])
      .annotate(
        OpenApi.Transform,
        describeResponse(302, "Redirect to the settings page (or an error toast)"),
      ),
  )
  .prefix("/api/slack")
  .annotate(OpenApi.Title, "Slack") {}

export class SlackInboundApi extends withApiDefaults(
  HttpApi.make("slackInbound").add(SlackInboundGroup),
) {}
