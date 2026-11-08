/**
 * Mobile push devices: `/api/push/devices`, the handlers.
 */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { pushDevices } from "../../../db/schema";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fieldsOf, readJson, trimmedField } from "../../json-body";
import { legacy } from "../../legacy";
import { guardSessionPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";
import { DeviceRemoved, PushDevice, PushDevicesApi, RegisteredDevice } from "./api";

const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[.+\]$/;

const PushDevicesHandlers = HttpApiBuilder.group(PushDevicesApi, "pushDevices", (handlers) =>
  handlers
    .handleRaw("register", ({ request }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const body = yield* readJson(request).pipe(Effect.flatMap(fieldsOf));

        const token = yield* trimmedField(body["expoPushToken"], "expoPushToken");
        if (!token || !EXPO_TOKEN_RE.test(token)) {
          return yield* badRequest("expoPushToken must be an ExponentPushToken[...] string");
        }
        if (token.length > 500) return yield* badRequest("expoPushToken is too long");
        const platform = body["platform"];
        if (platform !== "ios" && platform !== "android") {
          return yield* badRequest('platform must be "ios" or "android"');
        }
        const deviceName =
          (yield* trimmedField(body["deviceName"], "deviceName"))?.slice(0, 100) || null;

        const id = randomUUID();
        const now = new Date();
        // Upsert on the token: re-registration refreshes lastSeenAt, revives a
        // disabled device, and reassigns the row if the phone changed hands.
        const [row] = yield* legacy(() =>
          db
            .insert(pushDevices)
            .values({ id, userId: session.userId, expoPushToken: token, platform, deviceName })
            .onConflictDoUpdate({
              target: pushDevices.expoPushToken,
              set: {
                userId: session.userId,
                platform,
                deviceName,
                lastSeenAt: now,
                failureCount: 0,
                disabledAt: null,
                updatedAt: now,
              },
            })
            .returning({ id: pushDevices.id }),
        );
        return yield* respond(RegisteredDevice)({ id: row?.id ?? id });
      }),
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const rows = yield* legacy(() =>
          db
            .select()
            .from(pushDevices)
            .where(eq(pushDevices.userId, session.userId))
            .orderBy(pushDevices.createdAt),
        );
        return yield* respond(Schema.Array(PushDevice))(
          rows.map((r) => ({
            id: r.id,
            platform: r.platform,
            deviceName: r.deviceName,
            lastSeenAt: r.lastSeenAt.toISOString(),
            disabled: r.disabledAt !== null,
          })),
        );
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const result = yield* legacy(() =>
          db
            .delete(pushDevices)
            .where(and(eq(pushDevices.id, params.id), eq(pushDevices.userId, session.userId)))
            .returning({ id: pushDevices.id }),
        );
        if (result.length === 0) return yield* notFound("Device not found");
        return yield* respond(DeviceRemoved)({ ok: true });
      }),
    ),
);

/**
 * Every other path under `/api/push` needs a person's session first, as the
 * Hono mount's `use("/push/*", sessionMiddleware)` did.
 */
export const pushDevicesDomain = guardSessionPrefixes(
  makeDomain("push-devices", PushDevicesApi, PushDevicesHandlers),
  ["/api/push"],
);
