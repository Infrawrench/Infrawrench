/**
 * Twilio pager settings: `/api/org/:orgId/twilio`, the handlers.
 *
 * The bodies are read raw and checked field by field, as the Hono routes
 * did, so every refusal keeps its sentence. Credentials are encrypted per
 * organization before they are stored and are never read back out here.
 */
import crypto from "node:crypto";
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq } from "drizzle-orm";
import { encryptTwilioCredential, sendTestPage } from "@infrawrench/server-core/twilio-pager";
import { db } from "../../../db/client";
import { twilioRecipients, twilioSettings } from "../../../db/schema";
import { makeDomain } from "../../domain";
import { BadRequest, notFound, badRequest } from "../../errors";
import { fieldsOf, readJson } from "../../request-body";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { TwilioApi, Undocumented } from "./api";

// E.164: leading "+" then 1–15 digits.
const E164 = /^\+[1-9]\d{1,14}$/;
const E164_REFUSAL = "fromNumber must be E.164 (e.g. +15551234567)";

interface SettingsPayload {
  enabled: boolean;
  fromNumber: string | null;
  failureThreshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  /** True iff Account SID + Auth Token are both stored. We never echo the values. */
  credentialsConfigured: boolean;
}

/** `value.trim()` on a body field, which threw (a 500) for anything but a string. */
const trimmedString = (value: unknown, field: string): Effect.Effect<string> =>
  Predicate.isString(value)
    ? Effect.succeed(value.trim())
    : Effect.die(new TypeError(`${field}.trim is not a function`));

/** `value?.trim()`: absent stays absent, anything else but a string threw. */
const optionalTrimmedString = Effect.fnUntraced(function* (value: unknown, field: string) {
  if (Predicate.isNullish(value)) return undefined;
  return yield* trimmedString(value, field);
});

const TwilioHandlers = HttpApiBuilder.group(TwilioApi, "twilio", (handlers) =>
  handlers
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [row] = yield* legacy(() =>
          db.select().from(twilioSettings).where(eq(twilioSettings.organizationId, organizationId)),
        );
        const payload: SettingsPayload = row
          ? {
              enabled: row.enabled,
              fromNumber: row.fromNumber,
              failureThreshold: row.failureThreshold,
              windowMinutes: row.windowMinutes,
              cooldownMinutes: row.cooldownMinutes,
              credentialsConfigured: Boolean(row.encryptedAccountSid && row.encryptedAuthToken),
            }
          : {
              enabled: false,
              fromNumber: null,
              failureThreshold: 3,
              windowMinutes: 10,
              cooldownMinutes: 60,
              credentialsConfigured: false,
            };
        return yield* respond(Undocumented)(payload);
      }),
    )
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* readJson(request).pipe(Effect.flatMap(fieldsOf));

        const fromNumber = body["fromNumber"];
        if (fromNumber != null && fromNumber !== "") {
          if (!Predicate.isString(fromNumber) || !E164.test(fromNumber)) {
            return yield* badRequest(E164_REFUSAL);
          }
        }
        for (const [k, min] of [
          ["failureThreshold", 1],
          ["windowMinutes", 1],
          ["cooldownMinutes", 1],
        ] as const) {
          const v = body[k];
          if (v != null && !(Predicate.isNumber(v) && Number.isInteger(v) && v >= min)) {
            return yield* badRequest(`${k} must be an integer >= ${min}`);
          }
        }
        const enabled = body["enabled"];
        if (enabled != null && !Predicate.isBoolean(enabled)) {
          return yield* badRequest("enabled must be a boolean");
        }

        const patch: Partial<typeof twilioSettings.$inferInsert> = { updatedAt: new Date() };
        if (enabled != null) patch.enabled = enabled;
        if (fromNumber !== undefined) {
          patch.fromNumber = Predicate.isString(fromNumber) && fromNumber ? fromNumber : null;
        }
        const failureThreshold = body["failureThreshold"];
        if (Predicate.isNumber(failureThreshold)) patch.failureThreshold = failureThreshold;
        const windowMinutes = body["windowMinutes"];
        if (Predicate.isNumber(windowMinutes)) patch.windowMinutes = windowMinutes;
        const cooldownMinutes = body["cooldownMinutes"];
        if (Predicate.isNumber(cooldownMinutes)) patch.cooldownMinutes = cooldownMinutes;

        if (body["accountSid"] !== undefined) {
          const accountSid = yield* trimmedString(body["accountSid"], "accountSid");
          if (!accountSid) return yield* badRequest("accountSid cannot be empty");
          if (accountSid.length > 100) return yield* badRequest("accountSid is too long");
          const enc = yield* legacy(() =>
            encryptTwilioCredential(organizationId, "accountSid", accountSid),
          );
          patch.encryptedAccountSid = enc.ciphertext;
          patch.accountSidIv = enc.iv;
        }
        if (body["authToken"] !== undefined) {
          const authToken = yield* trimmedString(body["authToken"], "authToken");
          if (!authToken) return yield* badRequest("authToken cannot be empty");
          if (authToken.length > 200) return yield* badRequest("authToken is too long");
          const enc = yield* legacy(() =>
            encryptTwilioCredential(organizationId, "authToken", authToken),
          );
          patch.encryptedAuthToken = enc.ciphertext;
          patch.authTokenIv = enc.iv;
        }

        yield* legacy(() =>
          db
            .insert(twilioSettings)
            .values({
              organizationId,
              enabled: patch.enabled ?? false,
              encryptedAccountSid: patch.encryptedAccountSid ?? null,
              accountSidIv: patch.accountSidIv ?? null,
              encryptedAuthToken: patch.encryptedAuthToken ?? null,
              authTokenIv: patch.authTokenIv ?? null,
              fromNumber: patch.fromNumber ?? null,
              failureThreshold: patch.failureThreshold ?? 3,
              windowMinutes: patch.windowMinutes ?? 10,
              cooldownMinutes: patch.cooldownMinutes ?? 60,
            })
            .onConflictDoUpdate({ target: twilioSettings.organizationId, set: patch }),
        );
        return ok;
      }),
    )
    .handle("listRecipients", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() =>
          db
            .select()
            .from(twilioRecipients)
            .where(eq(twilioRecipients.organizationId, organizationId))
            .orderBy(twilioRecipients.createdAt),
        );
        return yield* respond(Undocumented)(
          rows.map((r) => ({
            id: r.id,
            displayName: r.displayName,
            phoneNumber: r.phoneNumber,
            sms: r.sms,
            voice: r.voice,
          })),
        );
      }),
    )
    .handleRaw("createRecipient", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* readJson(request).pipe(Effect.flatMap(fieldsOf));

        const displayName = yield* optionalTrimmedString(body["displayName"], "displayName");
        const phoneNumber = yield* optionalTrimmedString(body["phoneNumber"], "phoneNumber");
        if (!displayName) return yield* badRequest("displayName is required");
        if (!phoneNumber || !E164.test(phoneNumber)) {
          return yield* badRequest("phoneNumber must be E.164 (e.g. +15551234567)");
        }
        const rawSms = body["sms"] ?? true;
        const rawVoice = body["voice"] ?? true;
        if (!Predicate.isBoolean(rawSms)) return yield* badRequest("sms must be a boolean");
        if (!Predicate.isBoolean(rawVoice)) return yield* badRequest("voice must be a boolean");
        const sms = rawSms;
        const voice = rawVoice;
        if (!sms && !voice) {
          return yield* badRequest("Recipient must have SMS, voice, or both enabled");
        }

        const id = crypto.randomUUID();
        yield* legacy(() =>
          db.insert(twilioRecipients).values({
            id,
            organizationId,
            displayName,
            phoneNumber,
            sms,
            voice,
          }),
        );
        return yield* respond(Undocumented)({ id, displayName, phoneNumber, sms, voice });
      }),
    )
    .handle("deleteRecipient", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          db
            .delete(twilioRecipients)
            .where(
              and(
                eq(twilioRecipients.id, params.id),
                eq(twilioRecipients.organizationId, organizationId),
              ),
            )
            .returning({ id: twilioRecipients.id }),
        );
        if (result.length === 0) return yield* notFound("Recipient not found");
        return ok;
      }),
    )
    .handle("sendTest", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const summary = yield* legacyTry(
          () => sendTestPage(organizationId),
          (err) =>
            new BadRequest({
              error: err instanceof Error ? err.message : "Failed to send test page",
            }),
        );
        return yield* respond(Undocumented)({ ok: true, ...summary });
      }),
    ),
);

export const twilioDomain = makeDomain("twilio", TwilioApi, TwilioHandlers);
