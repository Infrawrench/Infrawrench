import { z } from "../zod";
import { strict } from "../common";
import type { BuildContext } from "../context";

/**
 * Alert email: the shared recipient shape every cost alert object carries
 * (still referenced by the Hono-documented cost routes) and the public
 * unsubscribe link.
 */

export const AlertEmailRecipients = strict({
  userIds: z.array(z.string()).max(50).openapi({
    description:
      "Organization members, by user id (from GET /alert-email). The member's current login address is read when the alert is sent, so an email change follows them and a member who leaves stops receiving.",
  }),
  addresses: z
    .array(z.string())
    .max(20)
    .openapi({
      description:
        "Extra addresses (a `finance@` alias, someone without a login). Each must pass the organization's external-address policy (GET /alert-email/settings), checked when saved and again when sent.",
      example: ["finance@example.com"],
    }),
}).openapi("AlertEmailRecipients", {
  description:
    "Who is emailed when this object fires, **in addition to** whatever the organization's alert routing rules decide. Delivered whether or not a rule matched and not held by quiet hours. On a write, omitting the field leaves the stored list unchanged; send empty arrays to clear it.",
});

/**
 * The public unsubscribe link. The org-scoped alert-email routes are
 * documented by their HttpApi domain (`http/domains/alert-email`).
 */
export function registerAlertEmailUnsubscribePaths(ctx: BuildContext) {
  const { registry } = ctx;

  for (const method of ["get", "post"] as const) {
    registry.registerPath({
      method,
      path: "/api/alert-email/unsubscribe",
      tags: ["Alerts"],
      summary:
        method === "get"
          ? "Unsubscribe confirmation page (from an alert email)"
          : "Unsubscribe an address from alert email (RFC 8058 one-click)",
      security: [],
      request: { query: z.object({ t: z.string() }) },
      responses: {
        200: { description: "An HTML page", content: { "text/html": { schema: z.string() } } },
        400: { description: "Invalid token", content: { "text/html": { schema: z.string() } } },
      },
    });
  }
}
