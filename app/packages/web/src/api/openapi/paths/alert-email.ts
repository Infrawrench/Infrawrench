import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

/**
 * Alert email: the shared recipient shape every cost alert object carries, the
 * picker's options, the external-address policy and the suppression list.
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

const AlertEmailExternalPolicy = z.enum(["member-domains", "any"]).openapi({
  description:
    "`member-domains` (the default): an extra address must be on a domain one of the organization's members signs in with, or one listed in `allowedDomains`. `any`: no restriction.",
});

const AlertEmailSettings = strict({
  externalPolicy: AlertEmailExternalPolicy,
  allowedDomains: z
    .array(z.string())
    .max(50)
    .openapi({
      description: "Extra domains accepted under `member-domains`, without the `@`.",
      example: ["partner-agency.com"],
    }),
}).openapi("AlertEmailSettings");

const AlertEmailMember = strict({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string(),
}).openapi("AlertEmailMember");

const AlertEmailOptions = strict({
  emailAvailable: z.boolean().openapi({
    description:
      "Whether this deployment has a mail provider configured. False means alert email is never sent.",
  }),
  members: z.array(AlertEmailMember),
  settings: AlertEmailSettings,
  memberDomains: z.array(z.string()).openapi({
    description: "Domains the organization's members sign in with: the implicit allowlist.",
  }),
}).openapi("AlertEmailOptions");

const AlertEmailSuppression = strict({
  id: z.string(),
  email: z.string(),
  createdAt: z.string().datetime(),
}).openapi("AlertEmailSuppression");

const AlertEmailSettingsView = strict({
  externalPolicy: AlertEmailExternalPolicy,
  allowedDomains: z.array(z.string()),
  emailAvailable: z.boolean(),
  memberDomains: z.array(z.string()),
  suppressions: z.array(AlertEmailSuppression).openapi({
    description:
      "Addresses that used the unsubscribe link in an alert email. They receive no alert email from this organization until an admin removes the entry.",
  }),
}).openapi("AlertEmailSettingsView");

export function registerAlertEmailPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/alert-email",
    tags: ["Alerts"],
    summary: "Recipient picker options for alert email",
    description:
      "Current members (with their login address), the external-address policy and whether email is available on this deployment: everything a client needs to edit the `emailRecipients` on a budget, cost change alert, anomaly settings or efficiency alert settings, or an email destination on an alert routing rule. Requires `costs:read`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Picker options",
        content: { "application/json": { schema: AlertEmailOptions } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/alert-email/settings",
    tags: ["Alerts"],
    summary: "Get the alert email policy and suppression list",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Policy, availability and suppressions",
        content: { "application/json": { schema: AlertEmailSettingsView } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/alert-email/settings",
    tags: ["Alerts"],
    summary: "Set the alert email external-address policy",
    description:
      "Whole object. Tightening the policy does not edit any stored recipient list: an address that no longer passes is skipped at send time, and loosening the policy again brings it back.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AlertEmailSettings } } },
    },
    responses: {
      200: {
        description: "The saved policy",
        content: { "application/json": { schema: AlertEmailSettingsView } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/alert-email/suppressions/{id}",
    tags: ["Alerts"],
    summary: "Resume alert email to an unsubscribed address",
    request: { params: OrgIdParam.extend({ id: z.string() }) },
    responses: {
      200: {
        description: "Removed",
        content: { "application/json": { schema: strict({ ok: z.boolean() }) } },
      },
      404: ErrorResponses[404],
    },
  });

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
