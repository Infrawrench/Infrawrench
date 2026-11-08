/**
 * Idle-rule tuning: `/api/org/:orgId/idle-findings`, the handlers: which
 * metric-based rules run, their thresholds and the lookback window, plus a
 * re-scan and the per-account collection status that explains an empty list.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  getOrgIdleSettings,
  IdleSettingsError,
  markOrgIdleScansDue,
  updateOrgIdleSettings,
  type IdleSettingsPatch,
} from "@infrawrench/server-core/idle/settings";
import { getIdleFindingsOverview } from "@infrawrench/server-core/idle/feed";
import type { IdleRuleOverride } from "@infrawrench/client-core";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { IdleFindingSettings, IdleFindingsApi, IdleFindingsOverview } from "./api";

const isPlainObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  Predicate.isObject(value) && !Array.isArray(value);

/** Shape-check the `rules` map; the bounds are the settings module's (it knows the declarations). */
function parseRules(raw: unknown): Record<string, IdleRuleOverride> | string {
  if (!isPlainObject(raw)) return "rules must be an object";
  const out: Record<string, IdleRuleOverride> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) return `rules["${key}"] must be an object`;
    for (const k of Object.keys(value)) {
      if (k !== "enabled" && k !== "thresholds") return `rules["${key}"].${k} is not a setting`;
    }
    const entry: IdleRuleOverride = {};
    const enabled = value["enabled"];
    if (enabled !== undefined) {
      if (!Predicate.isBoolean(enabled)) return `rules["${key}"].enabled must be a boolean`;
      entry.enabled = enabled;
    }
    const t = value["thresholds"];
    if (t !== undefined) {
      if (!isPlainObject(t)) return `rules["${key}"].thresholds must be an object`;
      const thresholds: Record<string, number> = {};
      for (const [tk, tv] of Object.entries(t)) {
        if (!Predicate.isNumber(tv)) return `rules["${key}"].thresholds.${tk} must be a number`;
        thresholds[tk] = tv;
      }
      entry.thresholds = thresholds;
    }
    out[key] = entry;
  }
  return out;
}

const IdleFindingsHandlers = HttpApiBuilder.group(IdleFindingsApi, "idleFindings", (handlers) =>
  handlers
    /** Settings, every declared rule with its effective thresholds, per-account status. */
    .handle("overview", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const overview = yield* legacy(() => getIdleFindingsOverview(organizationId));
        return yield* respond(IdleFindingsOverview)(overview);
      }),
    )
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getOrgIdleSettings(organizationId));
        return yield* respond(IdleFindingSettings)(settings);
      }),
    )
    /**
     * Every field optional, so one switch can be saved alone. `rules`, when
     * sent, replaces the whole overrides map (a rule left out runs with its
     * defaults). Out-of-range values are rejected, not clamped. Any change
     * makes every account due for a fresh collection.
     */
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const patch: IdleSettingsPatch = {};
        for (const key of Object.keys(body)) {
          if (key !== "enabled" && key !== "lookbackDays" && key !== "rules") {
            return yield* badRequest(`${key} is not a setting`);
          }
        }
        const enabled = body["enabled"];
        if (enabled !== undefined) {
          if (!Predicate.isBoolean(enabled)) return yield* badRequest("enabled must be a boolean");
          patch.enabled = enabled;
        }
        const lookbackDays = body["lookbackDays"];
        if (lookbackDays !== undefined) {
          if (!Predicate.isNumber(lookbackDays)) {
            return yield* badRequest("lookbackDays must be a number");
          }
          patch.lookbackDays = lookbackDays;
        }
        if (body["rules"] !== undefined) {
          const rules = parseRules(body["rules"]);
          if (Predicate.isString(rules)) return yield* badRequest(rules);
          patch.rules = rules;
        }
        if (Object.keys(patch).length === 0) return yield* badRequest("No settings supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* legacyTry(
          () => updateOrgIdleSettings(organizationId, patch, session.userId ?? null),
          (error) =>
            error instanceof IdleSettingsError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "idle_findings.settings_update",
            entityType: "organization",
            entityId: organizationId,
            metadata: {
              enabled: saved.enabled,
              lookbackDays: saved.lookbackDays,
              ruleOverrides: Object.keys(saved.rules).length,
            },
          }),
        );
        return yield* respond(IdleFindingSettings)(saved);
      }),
    )
    /** Make every account due on the next poller tick. */
    .handle("rescan", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* legacy(() => markOrgIdleScansDue(organizationId));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "idle_findings.rescan",
            entityType: "organization",
            entityId: organizationId,
          }),
        );
        return ok;
      }),
    ),
);

export const idleFindingsDomain = makeDomain(
  "idle-findings",
  IdleFindingsApi,
  IdleFindingsHandlers,
);
