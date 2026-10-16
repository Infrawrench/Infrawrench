import { z } from "../zod";
import { strict, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * Live status of filed issues: the schema pieces Jira, Linear and GitHub links
 * share (`issue-status.ts` in client-core is the contract), and the three
 * inbound tracker webhooks that keep them current.
 */

export const IssueStatusCategory = z
  .enum(["todo", "in_progress", "done", "canceled"])
  .openapi("IssueStatusCategory", {
    description:
      "Tracker-neutral progress. Jira's status category, Linear's workflow state type, and GitHub's state and close reason all map onto these four.",
  });

/** The status columns on every issue link. Null until the first sync. */
export const issueStatusFields = {
  status: z.string().nullable().openapi({
    description: "The tracker's own status name, e.g. `In Progress`, `Backlog`, `Closed`.",
    example: "In Progress",
  }),
  statusCategory: IssueStatusCategory.nullable(),
  assignee: z.string().nullable().openapi({
    description: "Assignee display name (Jira, Linear) or login (GitHub).",
  }),
  issueUpdatedAt: IsoDateTime.nullable().openapi({
    description: "When the issue last changed, as the tracker reports it.",
  }),
  statusSyncedAt: IsoDateTime.nullable().openapi({
    description: "When Infrawrench last learned the status, by webhook or poll.",
  }),
};

export const IssueWebhookState = strict({
  mode: z.enum(["registered", "manual"]).nullable().openapi({
    description:
      "`registered`: created in the tracker by Infrawrench. `manual`: created by a person with the URL and secret from here. Null: no webhook; statuses come from the poll.",
  }),
  url: z.string().nullable().openapi({ description: "The receiver URL the tracker posts to." }),
  lastDeliveryAt: IsoDateTime.nullable().openapi({
    description: "When the last correctly signed delivery arrived.",
  }),
}).openapi("IssueWebhookState");

export const IssueWebhookSetupResult = strict({
  webhook: IssueWebhookState,
  secret: z.string().optional().openapi({
    description:
      "Jira manual mode only: the signing secret to paste into Jira's webhook form. Returned this once; it is stored encrypted and never read back.",
  }),
  fallbackReason: z.string().optional().openapi({
    description: "Why automatic registration fell back to manual.",
  }),
}).openapi("IssueWebhookSetupResult");

export const IssueStatusRefreshResult = strict({
  checked: z.number().int().openapi({ description: "Links the tracker was asked about." }),
  changed: z.number().int().openapi({ description: "Links whose status, assignee or time moved." }),
}).openapi("IssueStatusRefreshResult");

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
