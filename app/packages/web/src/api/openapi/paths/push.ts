import { z } from "../zod";
import { AlertTriggerEnum, strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const Platform = z.enum(["ios", "android"]);

const PushDevice = strict({
  id: z.string(),
  platform: Platform,
  deviceName: z.string().nullable(),
  lastSeenAt: z.string().openapi({ description: "ISO timestamp of the last registration" }),
  disabled: z.boolean().openapi({ description: "True when delivery failures disabled the device" }),
}).openapi("PushDevice");

const MUTED_TRIGGERS_DESCRIPTION =
  "Triggers this member has turned off for this organization. Anything not listed is delivered, so a trigger added by a later release arrives without the client changing. A member who has never saved preferences gets ['resourceDrift']. A `channelOnly` trigger (one push cannot deliver, such as `weeklyDigest`) is accepted here and simply has no effect — rejecting a preference that is already a no-op would buy nothing.";

const PushPreferences = strict({
  mutedTriggers: z.array(AlertTriggerEnum).openapi({ description: MUTED_TRIGGERS_DESCRIPTION }),
}).openapi("PushPreferences");

// Registered as its own component rather than reusing `PushPreferences`, so the
// request body and the response shape can diverge without a client break — the
// response is what the server settled on, which need not stay identical to what
// a client is allowed to send.
const PushPreferencesUpdate = strict({
  mutedTriggers: z.array(AlertTriggerEnum).openapi({ description: MUTED_TRIGGERS_DESCRIPTION }),
}).openapi("PushPreferencesUpdate");

const PushRecipient = strict({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  mutedTriggers: z.array(AlertTriggerEnum),
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
      "Absent preferences default to every trigger enabled except resourceDrift, which ships muted.",
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
