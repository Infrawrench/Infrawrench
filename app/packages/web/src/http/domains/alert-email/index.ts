/**
 * Alert email, the handlers for the org-tree half. The public unsubscribe
 * pages are `../alert-email-unsubscribe`.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  ALERT_EMAIL_EXTERNAL_POLICIES,
  ALERT_EMAIL_LIMITS,
  alertEmailSettingsError,
  normalizeAlertEmailDomain,
  type AlertEmailSettings,
} from "@infrawrench/client-core";
import {
  getAlertEmailOptions,
  getAlertEmailSettingsView,
  removeAlertEmailSuppression,
  setAlertEmailSettings,
} from "@infrawrench/server-core/alerts/email";
import {
  AlertEmailApi,
  AlertEmailOptions,
  AlertEmailRemoved,
  AlertEmailSettingsView,
  badRequest,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { readJsonOr } from "../../request-body";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

type SettingsRead =
  | { readonly ok: true; readonly input: AlertEmailSettings }
  | { readonly ok: false; readonly error: string };

/**
 * The body as `AlertEmailSettings`, refused with the sentences
 * `alertEmailSettingsError` (client-core, the form's own check) words, in its
 * order. The narrowing is done here so the shared check sees typed input.
 */
function readSettings(body: unknown): SettingsRead {
  if (!Predicate.isObject(body)) return { ok: false, error: "Invalid settings" };
  const externalPolicy = ALERT_EMAIL_EXTERNAL_POLICIES.find((p) => p === body["externalPolicy"]);
  if (!externalPolicy) {
    return {
      ok: false,
      error: `externalPolicy must be one of ${ALERT_EMAIL_EXTERNAL_POLICIES.join(", ")}`,
    };
  }
  const raw: unknown = body["allowedDomains"];
  if (!Array.isArray(raw)) return { ok: false, error: "allowedDomains must be an array" };
  const domains: readonly unknown[] = raw;
  if (domains.length > ALERT_EMAIL_LIMITS.maxAllowedDomains) {
    return { ok: false, error: `At most ${ALERT_EMAIL_LIMITS.maxAllowedDomains} allowed domains` };
  }
  const allowedDomains: string[] = [];
  for (const d of domains) {
    if (!Predicate.isString(d) || !normalizeAlertEmailDomain(d)) {
      return { ok: false, error: `"${String(d)}" is not a domain name` };
    }
    allowedDomains.push(d);
  }
  const input: AlertEmailSettings = { externalPolicy, allowedDomains };
  const error = alertEmailSettingsError(input);
  return error ? { ok: false, error } : { ok: true, input };
}

const AlertEmailHandlers = HttpApiBuilder.group(AlertEmailApi, "alertEmail", (handlers) =>
  handlers
    .handle("options", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const options = yield* legacy(() => getAlertEmailOptions(organizationId));
        return yield* respond(AlertEmailOptions)(options);
      }),
    )
    .handle("settings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const view = yield* legacy(() => getAlertEmailSettingsView(organizationId));
        return yield* respond(AlertEmailSettingsView)(view);
      }),
    )
    // Whole object. Tightening the policy edits no stored recipient list: an
    // address that no longer passes is skipped at send time, so loosening it
    // again brings it back without anybody re-entering it.
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = readSettings(yield* readJsonOr(request, null));
        if (!read.ok) return yield* badRequest(read.error);
        const saved = yield* legacy(() => setAlertEmailSettings(organizationId, read.input));
        yield* legacy(() =>
          logAudit({
            organizationId,
            ...(session.userId ? { userId: session.userId } : {}),
            action: "alert_email.settings.update",
            entityType: "alert_email_settings",
            entityId: organizationId,
            metadata: {
              externalPolicy: saved.externalPolicy,
              allowedDomains: saved.allowedDomains,
            },
          }),
        );
        const view = yield* legacy(() => getAlertEmailSettingsView(organizationId));
        return yield* respond(AlertEmailSettingsView)(view);
      }),
    )
    // Resume mail to an address that unsubscribed.
    .handle("removeSuppression", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* legacy(() => removeAlertEmailSuppression(organizationId, params.id));
        if (!removed) return yield* notFound();
        yield* legacy(() =>
          logAudit({
            organizationId,
            ...(session.userId ? { userId: session.userId } : {}),
            action: "alert_email.suppression.remove",
            entityType: "alert_email_suppression",
            entityId: params.id,
          }),
        );
        return yield* respond(AlertEmailRemoved)(ok);
      }),
    ),
);

export const alertEmailDomain = makeDomain("alert-email", AlertEmailApi, AlertEmailHandlers);
