/**
 * Push notification preferences: `/api/org/:orgId/push`, the handlers.
 *
 * Preferences are per (user, org); both work with the mobile app's WorkOS
 * Bearer tokens because the org auth chain accepts them. Device
 * registration, user-scoped, is the `push-devices` domain (`/api/push/devices`).
 */
import { randomUUID } from "node:crypto";
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, isNull } from "drizzle-orm";
import { sendTestPushToUser } from "@infrawrench/server-core/push/dispatch";
import {
  DEFAULT_MUTED_TRIGGERS,
  isAlertTrigger,
  type AlertTrigger,
} from "@infrawrench/client-core";
import { db } from "../../../db/client";
import { organizationMembers, pushDevices, pushPreferences, users } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest } from "../../errors";
import { fieldsOf, readJson } from "../../request-body";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { PushApi, PushOk, PushPreferences, PushRecipient, PushTestResult } from "./api";

const isKnownTrigger = (t: unknown): t is AlertTrigger =>
  Predicate.isString(t) && isAlertTrigger(t);

interface RecipientEntry {
  userId: string;
  email: string;
  displayName: string | null;
  mutedTriggers: unknown;
  devices: Array<{ id: string; platform: string; deviceName: string | null }>;
}

const PushHandlers = HttpApiBuilder.group(PushApi, "push", (handlers) =>
  handlers
    .handle("getPreferences", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const [row] = yield* legacy(() =>
          db
            .select()
            .from(pushPreferences)
            .where(
              and(
                eq(pushPreferences.userId, session.userId),
                eq(pushPreferences.organizationId, organizationId),
              ),
            ),
        );
        // No row means the shipped defaults, not "nothing muted": `resourceDrift`
        // ships muted, and returning an empty list would tell the client the opposite.
        return yield* respond(PushPreferences)({
          mutedTriggers: row?.mutedTriggers ?? [...DEFAULT_MUTED_TRIGGERS],
        });
      }),
    )
    /**
     * A member's mutes for this org. One array rather than a boolean per
     * trigger, so a new trigger needs no column, field, default or audit key
     * here: "not muted" is the default for any name the member has not written
     * down.
     */
    .handleRaw("updatePreferences", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readJson(request).pipe(Effect.flatMap(fieldsOf));
        const requested = body["mutedTriggers"];
        if (!Array.isArray(requested)) {
          return yield* badRequest("mutedTriggers must be an array");
        }
        // Unknown names are rejected rather than stored. A mute list is small and
        // hand-editable, and silently keeping a typo would look like it worked
        // while the trigger it was meant to silence kept arriving.
        const list: readonly unknown[] = requested;
        const unknown = list.filter((t) => !isKnownTrigger(t));
        if (unknown.length > 0) {
          return yield* badRequest(`Unknown trigger(s): ${unknown.join(", ")}`);
        }
        const muted = [...new Set(list.filter(isKnownTrigger))];

        const now = new Date();
        yield* legacy(() =>
          db
            .insert(pushPreferences)
            .values({
              id: randomUUID(),
              userId: session.userId,
              organizationId,
              mutedTriggers: muted,
            })
            .onConflictDoUpdate({
              target: [pushPreferences.userId, pushPreferences.organizationId],
              set: { mutedTriggers: muted, updatedAt: now },
            }),
        );

        // Awaited, as the Hono route did; `Promise.resolve` because a stubbed
        // `logAudit` may hand back a plain value.
        yield* legacy(() =>
          Promise.resolve(
            logAudit({
              organizationId,
              userId: session.userId,
              action: "push.preferences.update",
              entityType: "push_preferences",
              entityId: session.userId,
              metadata: { mutedTriggers: muted },
            }),
          ),
        );
        return yield* respond(PushOk)({ ok: true });
      }),
    )
    /**
     * Admin roster: which members have at least one active device, and their
     * effective per-org preferences.
     */
    .handle("listRecipients", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() =>
          db
            .select({
              userId: users.id,
              email: users.email,
              displayName: users.displayName,
              deviceId: pushDevices.id,
              platform: pushDevices.platform,
              deviceName: pushDevices.deviceName,
              disabledAt: pushDevices.disabledAt,
              mutedTriggers: pushPreferences.mutedTriggers,
            })
            .from(organizationMembers)
            .innerJoin(users, eq(organizationMembers.userId, users.id))
            .innerJoin(pushDevices, eq(pushDevices.userId, organizationMembers.userId))
            .leftJoin(
              pushPreferences,
              and(
                eq(pushPreferences.userId, organizationMembers.userId),
                eq(pushPreferences.organizationId, organizationMembers.organizationId),
              ),
            )
            .where(
              and(
                eq(organizationMembers.organizationId, organizationId),
                isNull(pushDevices.disabledAt),
              ),
            ),
        );

        // Group devices per member; an absent preference row means the shipped
        // defaults, which is not the same as "nothing muted".
        const byUser = new Map<string, RecipientEntry>();
        for (const r of rows) {
          let entry = byUser.get(r.userId);
          if (!entry) {
            entry = {
              userId: r.userId,
              email: r.email,
              displayName: r.displayName,
              mutedTriggers: r.mutedTriggers ?? [...DEFAULT_MUTED_TRIGGERS],
              devices: [],
            };
            byUser.set(r.userId, entry);
          }
          entry.devices.push({ id: r.deviceId, platform: r.platform, deviceName: r.deviceName });
        }
        return yield* respond(Schema.Array(PushRecipient))([...byUser.values()]);
      }),
    )
    .handle("sendTest", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const summary = yield* legacyTry(
          () => sendTestPushToUser(session.userId, organizationId),
          (err) =>
            new BadRequest({
              error: err instanceof Error ? err.message : "Failed to send test push",
            }),
        );
        return yield* respond(PushTestResult)({ ok: true, ...summary });
      }),
    ),
);

export const pushDomain = makeDomain("push", PushApi, PushHandlers);
