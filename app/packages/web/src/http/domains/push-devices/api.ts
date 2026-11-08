/**
 * Mobile push devices: `/api/push/devices`, the endpoint definitions.
 *
 * User-scoped (a phone belongs to a person, registered once across orgs) and
 * session-only; the mobile app's WorkOS Bearer tokens authenticate as a
 * person. The per-(user, org) preferences, roster and test send are the `push`
 * domain (`http/domains/push`). Every path is in the public spec's withheld
 * list, so the operations are `x-internal`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { SessionAuth } from "../../middleware-tags";
import { optionalRequestBody } from "../../schemas/documented";

const Platform = Schema.Literals(["ios", "android"]);

const RegisterDevice = Schema.Struct({
  expoPushToken: Schema.String.annotate({
    description: "ExponentPushToken[...] from expo-notifications",
  }),
  platform: Platform,
  deviceName: Schema.optionalKey(Schema.String),
});

export const RegisteredDevice = Schema.Struct({ id: Schema.String });

export const PushDevice = Schema.Struct({
  id: Schema.String,
  platform: Platform,
  deviceName: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.String.annotate({ description: "ISO timestamp of the last registration" }),
  disabled: Schema.Boolean.annotate({
    description: "True when delivery failures disabled the device",
  }),
}).annotate({ identifier: "PushDevice" });

export const DeviceRemoved = Schema.Struct({ ok: Schema.Boolean });

export class PushDevicesGroup extends HttpApiGroup.make("pushDevices")
  .add(
    HttpApiEndpoint.post("register", "/devices", {
      payload: RegisterDevice,
      success: RegisteredDevice,
      error: BadRequest,
    })
      .annotate(OpenApi.Summary, "Register a mobile push device")
      .annotate(
        OpenApi.Description,
        "Registers (or refreshes) an Expo push token for the calling user. Devices are user-scoped: one registration covers every organization the user belongs to. Re-registering an existing token refreshes it and re-enables a device disabled by delivery failures.",
      )
      .annotate(SuccessDescription, "Device id")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("list", "/devices", { success: Schema.Array(PushDevice) })
      .annotate(OpenApi.Summary, "List the caller's registered devices")
      .annotate(SuccessDescription, "Devices"),
    HttpApiEndpoint.delete("remove", "/devices/:id", {
      params: { id: Schema.String },
      success: DeviceRemoved,
      error: NotFound,
    })
      .annotate(OpenApi.Summary, "Remove one of the caller's devices")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/push")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Push") {}

export class PushDevicesApi extends withApiDefaults(
  HttpApi.make("pushDevices").add(PushDevicesGroup),
) {}
