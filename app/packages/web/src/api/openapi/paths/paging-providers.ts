import { z } from "../zod";
import type { BuildContext } from "../context";

/**
 * The inbound paging-provider webhook, the one paging route still on Hono:
 * public, and authenticated by the provider's signature over the raw body.
 * The org-tree routes are documented by their HttpApi domain
 * (`http/domains/paging-providers/`).
 */
export function registerPagingWebhookPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/paging-webhooks/{token}",
    tags: ["Paging providers"],
    summary: "Inbound paging provider webhook",
    description:
      "Called by the provider, not by clients. The token in the path picks the account; the provider's signature, verified with the stored secret, authenticates the delivery. The payload is treated as a nudge: each incident it names is re-read from the provider's API.",
    security: [],
    request: { params: z.object({ token: z.string() }) },
    responses: {
      202: { description: "Accepted" },
      401: { description: "The signature did not verify" },
      404: { description: "Unknown token" },
    },
  });
}
