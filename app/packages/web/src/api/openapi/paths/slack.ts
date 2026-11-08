import { z } from "../zod";
import { strict, ErrorResponses } from "../common";
import type { BuildContext } from "../context";

/**
 * The inbound Slack endpoints (public, signature-verified). The org-scoped
 * Slack routes are documented by their HttpApi domain (`http/domains/slack`).
 */
export function registerSlackInboundPaths(ctx: BuildContext) {
  const { registry } = ctx;

  // --- Inbound Slack (public, signature-verified; internal in the published
  // spec: these are called by Slack and the browser, never by API clients).

  const slackSignatureHeaders = strict({
    "x-slack-signature": z
      .string()
      .openapi({ description: "v0=<hex HMAC-SHA256 of `v0:<timestamp>:<raw body>`>" }),
    "x-slack-request-timestamp": z
      .string()
      .openapi({ description: "Unix seconds; requests older than 5 minutes are rejected" }),
  });

  registry.registerPath({
    method: "post",
    path: "/api/slack/commands",
    tags: ["Slack"],
    summary: "Slack slash-command endpoint (/infrawrench)",
    description:
      "Public; verified against the app's signing secret. Handles `costs`, `status <resource>`, `link`, `unlink` and `help`. Acknowledged immediately; the ephemeral reply is delivered through the payload's `response_url`. The Slack user must have linked their account (`/infrawrench link`) and hold the same permission the equivalent web surface requires (`costs:read`, `resources:read`).",
    security: [],
    request: {
      headers: slackSignatureHeaders,
      body: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: z.unknown().openapi({ description: "Slack's slash-command form payload" }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: "Acknowledged; the reply is delivered through response_url" },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/slack/interactions",
    tags: ["Slack"],
    summary: "Slack interactivity endpoint (Approve/Deny buttons)",
    description:
      "Public; verified against the app's signing secret. Receives `block_actions` payloads from the Approve/Deny buttons on approval messages and the status disambiguation picker. Button decisions resolve through the same code path as the web UI; the linked member needs `workflows:approve` (workflow approvals) or must own the conversation and hold `chat:write` (chat agent tool approvals).",
    security: [],
    request: {
      headers: slackSignatureHeaders,
      body: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: z
              .unknown()
              .openapi({ description: "`payload=<JSON>` interaction envelope from Slack" }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: "Acknowledged; feedback rides response_url and message updates" },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/slack/link",
    tags: ["Slack"],
    summary: "Confirm linking a Slack user to the signed-in member (browser)",
    description:
      "Landing for the signed link URL the slash-command endpoints hand to unknown Slack users. Requires a browser session (bounces through sign-in), verifies the short-lived token and membership of the token's organization, then renders a confirmation page naming the Slack user and organization. The write itself happens in the CSRF-guarded POST the page submits.",
    security: [],
    request: {
      query: strict({
        token: z.string().openapi({ description: "Signed link token from Slack (15-minute TTL)" }),
      }),
    },
    responses: {
      200: {
        description: "Confirmation page (HTML form that POSTs back to this path)",
        content: { "text/html": { schema: z.string() } },
      },
      302: { description: "Redirect to sign-in or an error toast" },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/slack/link",
    tags: ["Slack"],
    summary: "Store the Slack-user ↔ member link (confirmation form target)",
    description:
      "Submitted by the confirmation page above. Requires the browser session, the signed link token, and the double-submit CSRF pair (cookie + form field) minted by the GET; on success stores the Slack-user ↔ member mapping and redirects to the notification settings page.",
    security: [],
    request: {
      body: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: strict({
              token: z
                .string()
                .openapi({ description: "Signed link token from Slack (15-minute TTL)" }),
              csrf: z
                .string()
                .openapi({ description: "CSRF value matching the slack_link_csrf cookie" }),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      302: { description: "Redirect to the settings page (or an error toast)" },
      401: ErrorResponses[401],
    },
  });
}
