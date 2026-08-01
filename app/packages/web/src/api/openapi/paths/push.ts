import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const Platform = z.enum(["ios", "android"]);

const PushDevice = strict({
  id: z.string(),
  platform: Platform,
  deviceName: z.string().nullable(),
  lastSeenAt: z.string().openapi({ description: "ISO timestamp of the last registration" }),
  disabled: z.boolean().openapi({ description: "True when delivery failures disabled the device" }),
}).openapi("PushDevice");

const PushPreferences = strict({
  syncIncidents: z.boolean(),
  budgetAlerts: z.boolean(),
  anomalyAlerts: z
    .boolean()
    .openapi({ description: "Statistical spend-spike (cost anomaly) alerts" }),
  resourceDrift: z.boolean().openapi({
    description:
      "Batched resource-drift digests from the change timeline. Defaults to false — drift is continuous where the other triggers are exceptional.",
  }),
  workflowPages: z.boolean().openapi({
    description:
      "Pages and approval requests raised by a workflow (infra.page / infra.waitForApproval) or by POST /pages",
  }),
  providerIncidents: z.boolean().openapi({
    description: "A provider status-page incident overlaps resources you hold.",
  }),
}).openapi("PushPreferences");

// Registered under its own name — `.partial()` on a registered schema would
// otherwise collapse back into the full $ref (both fields required) in the
// generated document.
const PushPreferencesUpdate = strict({
  syncIncidents: z.boolean().optional(),
  budgetAlerts: z.boolean().optional(),
  anomalyAlerts: z.boolean().optional(),
  resourceDrift: z.boolean().optional(),
  workflowPages: z.boolean().optional(),
  providerIncidents: z.boolean().optional(),
}).openapi("PushPreferencesUpdate");

const PushRecipient = strict({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  syncIncidents: z.boolean(),
  budgetAlerts: z.boolean(),
  anomalyAlerts: z.boolean(),
  resourceDrift: z.boolean(),
  workflowPages: z.boolean(),
  providerIncidents: z.boolean(),
  devices: z.array(
    strict({
      id: z.string(),
      platform: Platform,
      deviceName: z.string().nullable(),
    }),
  ),
}).openapi("PushRecipient");

export function registerPushPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/push/devices",
    tags: ["Push"],
    summary: "Register a mobile push device",
    description:
      "Registers (or refreshes) an Expo push token for the calling user. Devices are user-scoped: one registration covers every organization the user belongs to. Re-registering an existing token refreshes it and re-enables a device disabled by delivery failures.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: strict({
              expoPushToken: z
                .string()
                .openapi({ description: "ExponentPushToken[...] from expo-notifications" }),
              platform: Platform,
              deviceName: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Device id",
        content: { "application/json": { schema: strict({ id: z.string() }) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/push/devices",
    tags: ["Push"],
    summary: "List the caller's registered devices",
    responses: {
      200: {
        description: "Devices",
        content: { "application/json": { schema: z.array(PushDevice) } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/push/devices/{id}",
    tags: ["Push"],
    summary: "Remove one of the caller's devices",
    request: { params: strict({ id: z.string() }) },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: strict({ ok: z.boolean() }) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/push/preferences",
    tags: ["Push"],
    summary: "Get the caller's push preferences for this organization",
    description:
      "Absent preferences default to every trigger enabled except resourceDrift, which defaults to false.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Preferences",
        content: { "application/json": { schema: PushPreferences } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/push/preferences",
    tags: ["Push"],
    summary: "Update the caller's push preferences for this organization",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: PushPreferencesUpdate } },
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: strict({ ok: z.boolean() }) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/push/recipients",
    tags: ["Push"],
    summary: "List members receiving push notifications",
    description: "Admin roster of members with at least one active device.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Recipients",
        content: { "application/json": { schema: z.array(PushRecipient) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/push/test",
    tags: ["Push"],
    summary: "Send a test notification to the caller's devices",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Delivery summary",
        content: {
          "application/json": {
            schema: strict({
              ok: z.boolean(),
              attempted: z.number().int(),
              succeeded: z.number().int(),
            }),
          },
        },
      },
      400: ErrorResponses[400],
    },
  });
}
