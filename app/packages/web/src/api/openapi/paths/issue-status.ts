import { z } from "../zod";
import type { BuildContext } from "../context";

/**
 * The three inbound tracker webhooks that keep the status of filed issues
 * current. The schema pieces the Jira, Linear and GitHub links share are in
 * `http/schemas/issue-status.ts`, with the HttpApi domains that send them.
 */

export function registerIssueWebhookPaths({ registry }: BuildContext) {
  const responses = {
    202: { description: "Applied" },
    401: { description: "The signature did not verify" },
    404: { description: "Unknown token, or (GitHub) no webhook secret configured on the server" },
    500: { description: "Processing failed; the tracker retries" },
  };
  registry.registerPath({
    method: "post",
    path: "/api/issue-webhooks/jira/{token}",
    tags: ["Jira"],
    summary: "Inbound Jira webhook for issue status",
    description:
      "Called by Jira, not by clients. The token in the path picks the organization; `X-Hub-Signature: sha256=<hex>`, an HMAC of the raw body with the stored secret, authenticates the delivery. Handles `jira:issue_updated` and `jira:issue_deleted`.",
    security: [],
    request: { params: z.object({ token: z.string() }) },
    responses,
  });
  registry.registerPath({
    method: "post",
    path: "/api/issue-webhooks/linear/{token}",
    tags: ["Linear"],
    summary: "Inbound Linear webhook for issue status",
    description:
      "Called by Linear, not by clients. The token in the path picks the organization; `Linear-Signature` (hex HMAC-SHA256 of the raw body) authenticates the delivery, and `webhookTimestamp` must be within a minute. Handles `Issue` create, update and remove.",
    security: [],
    request: { params: z.object({ token: z.string() }) },
    responses,
  });
  registry.registerPath({
    method: "post",
    path: "/api/issue-webhooks/github",
    tags: ["GitHub issues"],
    summary: "Inbound GitHub App webhook for issue status",
    description:
      "The GitHub App's webhook URL. `X-Hub-Signature-256` is verified with the server's `GITHUB_APP_WEBHOOK_SECRET`; `issues` events update the status of filed issues and `ping` is acknowledged. Every other event is ignored.",
    security: [],
    responses: { ...responses, 200: { description: "Ping acknowledged" } },
  });
}
