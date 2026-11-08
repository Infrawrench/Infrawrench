/**
 * Weekly digest settings, the handlers. Timezone and range checks live in
 * server-core so the poller and the API cannot disagree about what a valid
 * schedule is; its refusals come back as 400s with its own sentence.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  getOrgDigestSettings,
  sendWeeklyDigestNow,
  updateOrgDigestSettings,
  type DigestSettingsPatch,
  type DigestSettingsRecord,
} from "@infrawrench/server-core/digest/weekly";
import {
  addDigestEmailRecipient,
  listDigestEmailRecipients,
  removeDigestEmailRecipient,
} from "@infrawrench/server-core/digest/recipients";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fieldsOf, readJson } from "../../request-body";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  DigestApi,
  DigestEmailRecipient,
  DigestEmailRecipientList,
  DigestRemoved,
  DigestSendResult,
  DigestSettings,
} from "./api";

function toWire(s: DigestSettingsRecord) {
  return {
    enabled: s.enabled,
    lastSentWeekStart: s.lastSentWeekStart,
    lastSentAt: s.lastSentAt ? s.lastSentAt.toISOString() : null,
    timezone: s.timezone,
    sendDay: s.sendDay,
    sendHour: s.sendHour,
    narrativeEnabled: s.narrativeEnabled,
    narrativeAvailable: s.narrativeAvailable,
    emailAvailable: s.emailAvailable,
    attemptCount: s.attemptCount,
    lastAttemptAt: s.lastAttemptAt ? s.lastAttemptAt.toISOString() : null,
    lastStatus: s.lastStatus,
    lastError: s.lastError,
    nextAttemptAt: s.nextAttemptAt ? s.nextAttemptAt.toISOString() : null,
  };
}

const refusedWith = (fallback: string) => (error: unknown) =>
  badRequest(error instanceof Error ? error.message : fallback);

const DigestHandlers = HttpApiBuilder.group(DigestApi, "digest", (handlers) =>
  handlers
    // An org that never touched its settings reads as disabled.
    .handle("get", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getOrgDigestSettings(organizationId));
        return yield* respond(DigestSettings)(toWire(settings));
      }),
    )
    // Every field optional, so the toggle, the schedule and the narrative
    // opt-in can each be saved on their own.
    .handleRaw("update", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        const patch: DigestSettingsPatch = {};
        if (body["enabled"] !== undefined) {
          if (!Predicate.isBoolean(body["enabled"])) {
            return yield* badRequest("enabled must be a boolean");
          }
          patch.enabled = body["enabled"];
        }
        if (body["narrativeEnabled"] !== undefined) {
          if (!Predicate.isBoolean(body["narrativeEnabled"])) {
            return yield* badRequest("narrativeEnabled must be a boolean");
          }
          patch.narrativeEnabled = body["narrativeEnabled"];
        }
        if (body["timezone"] !== undefined) {
          if (!Predicate.isString(body["timezone"])) {
            return yield* badRequest("timezone must be an IANA time zone name");
          }
          patch.timezone = body["timezone"];
        }
        if (body["sendDay"] !== undefined) {
          if (!Predicate.isNumber(body["sendDay"])) {
            return yield* badRequest("sendDay must be 1 (Monday) through 7 (Sunday)");
          }
          patch.sendDay = body["sendDay"];
        }
        if (body["sendHour"] !== undefined) {
          if (!Predicate.isNumber(body["sendHour"])) {
            return yield* badRequest("sendHour must be an integer from 0 to 23");
          }
          patch.sendHour = body["sendHour"];
        }
        if (Object.keys(patch).length === 0) return yield* badRequest("No settings supplied");
        const saved = yield* legacyTry(
          () => updateOrgDigestSettings(organizationId, patch),
          refusedWith("Failed to save digest settings"),
        );
        return yield* respond(DigestSettings)(toWire(saved));
      }),
    )
    // Regardless of the schedule or the enabled flag. "Nothing is routed to
    // receive it" is the refusal the user needs to see.
    .handle("send", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () => sendWeeklyDigestNow(organizationId),
          refusedWith("Failed to send the digest"),
        );
        return yield* respond(DigestSendResult)({
          ok: true,
          attempted: result.attempted,
          succeeded: result.succeeded,
          slack: result.slack,
          teams: result.teams,
          email: result.email,
        });
      }),
    )
    .handle("recipients", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const recipients = yield* legacy(() => listDigestEmailRecipients(organizationId));
        return yield* respond(DigestEmailRecipientList)({ recipients });
      }),
    )
    // Re-adding an address already on the list is a no-op.
    .handleRaw("addRecipient", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { email } = yield* fieldsOf(yield* readJson(request));
        if (!Predicate.isString(email)) return yield* badRequest("email is required");
        const recipient = yield* legacyTry(
          () => addDigestEmailRecipient(organizationId, email, session.userId ?? null),
          refusedWith("Failed to add the recipient"),
        );
        return yield* respond(DigestEmailRecipient)(recipient);
      }),
    )
    .handle("removeRecipient", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const removed = yield* legacy(() =>
          removeDigestEmailRecipient(organizationId, params.recipientId),
        );
        if (!removed) return yield* notFound("Recipient not found");
        return yield* respond(DigestRemoved)(ok);
      }),
    ),
);

export const digestDomain = makeDomain("digest", DigestApi, DigestHandlers);
