/**
 * Per-org tuning of the metric-based idle rules (`org_idle_finding_settings`).
 *
 * The `extended-support/settings.ts` protocol: a missing row means the
 * shipped defaults, writes are a patch where every field is optional, and a
 * value outside its documented bound is **rejected, not clamped** (a form that
 * shows a number the user did not type reads as the setting not having
 * saved). Reads still clamp, as the last line of defence for a row written by
 * hand or by an older client.
 *
 * Rule overrides are validated against the live plugin declarations: an
 * unknown rule or threshold key is a 400, because a typo in Terraform that
 * silently did nothing would be a rule the user believes is off and is not.
 *
 * Any change makes every account in the org due for a fresh collection, so a
 * new threshold or window shows up on the next poller tick rather than the
 * next day.
 */
import { eq, sql } from "drizzle-orm";
import {
  clampIdleLookbackDays,
  idleRuleKey,
  resolveIdleThresholds,
  type IdleFindingsCapabilityDeclaration,
  type IdleRuleDeclaration,
  type IdleRuleRequest,
} from "@infrawrench/plugin-base";
import {
  DEFAULT_IDLE_FINDING_SETTINGS,
  IDLE_FINDING_LIMITS,
  type IdleFindingSettings,
  type IdleRuleOverride,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { accountIdlePolls, orgIdleFindingSettings } from "../db/schema.js";
import { loadPlugins } from "../plugin-loader.js";

export { IDLE_FINDING_LIMITS };

export class IdleSettingsError extends Error {
  readonly status = 400 as const;
}

/** A stored rules bag forced back into shape: finite thresholds, boolean switches. */
function cleanRules(raw: unknown): Record<string, IdleRuleOverride> {
  const out: Record<string, IdleRuleOverride> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as { enabled?: unknown; thresholds?: unknown };
    const entry: IdleRuleOverride = {};
    if (typeof v.enabled === "boolean") entry.enabled = v.enabled;
    if (v.thresholds && typeof v.thresholds === "object" && !Array.isArray(v.thresholds)) {
      const thresholds: Record<string, number> = {};
      for (const [k, n] of Object.entries(v.thresholds as Record<string, unknown>)) {
        if (typeof n === "number" && Number.isFinite(n)) thresholds[k] = n;
      }
      if (Object.keys(thresholds).length > 0) entry.thresholds = thresholds;
    }
    if (entry.enabled !== undefined || entry.thresholds) out[key] = entry;
  }
  return out;
}

/** A stored (or hand-written) row read back inside the documented bounds. */
export function normalizeIdleSettings(input: Partial<IdleFindingSettings>): IdleFindingSettings {
  return {
    enabled:
      typeof input.enabled === "boolean" ? input.enabled : DEFAULT_IDLE_FINDING_SETTINGS.enabled,
    lookbackDays: clampIdleLookbackDays(
      input.lookbackDays ?? DEFAULT_IDLE_FINDING_SETTINGS.lookbackDays,
    ),
    rules: cleanRules(input.rules),
  };
}

export async function getOrgIdleSettings(organizationId: string): Promise<IdleFindingSettings> {
  const [row] = await db
    .select()
    .from(orgIdleFindingSettings)
    .where(eq(orgIdleFindingSettings.organizationId, organizationId))
    .limit(1);
  return row
    ? normalizeIdleSettings({
        enabled: row.enabled,
        lookbackDays: row.lookbackDays,
        rules: row.rules,
      })
    : { ...DEFAULT_IDLE_FINDING_SETTINGS, rules: {} };
}

/** Every declared rule across the loaded plugins, keyed by `pluginId:ruleId`. */
export async function declaredIdleRules(): Promise<
  Map<string, { pluginId: string; rule: IdleRuleDeclaration }>
> {
  const out = new Map<string, { pluginId: string; rule: IdleRuleDeclaration }>();
  for (const { plugin } of await loadPlugins()) {
    for (const rule of plugin.manifest.idleFindings?.rules ?? []) {
      out.set(idleRuleKey(plugin.manifest.id, rule.id), { pluginId: plugin.manifest.id, rule });
    }
  }
  return out;
}

export interface IdleSettingsPatch {
  enabled?: boolean;
  lookbackDays?: number;
  /** Replaces the whole overrides map. */
  rules?: Record<string, IdleRuleOverride>;
}

/**
 * Validate a patch against the bounds and the declared rules. Pure over the
 * declarations so the route test can drive it without plugins.
 */
export function validateIdleSettingsPatch(
  patch: IdleSettingsPatch,
  declared: ReadonlyMap<string, { rule: Pick<IdleRuleDeclaration, "thresholds"> }>,
): void {
  if (patch.lookbackDays !== undefined) {
    const n = patch.lookbackDays;
    if (
      !Number.isInteger(n) ||
      n < IDLE_FINDING_LIMITS.minLookbackDays ||
      n > IDLE_FINDING_LIMITS.maxLookbackDays
    ) {
      throw new IdleSettingsError(
        `lookbackDays must be a whole number from ${IDLE_FINDING_LIMITS.minLookbackDays} to ${IDLE_FINDING_LIMITS.maxLookbackDays}`,
      );
    }
  }
  if (patch.rules !== undefined) {
    const entries = Object.entries(patch.rules);
    if (entries.length > IDLE_FINDING_LIMITS.maxRules) {
      throw new IdleSettingsError(`At most ${IDLE_FINDING_LIMITS.maxRules} rule overrides`);
    }
    for (const [key, override] of entries) {
      const entry = declared.get(key);
      if (!entry) throw new IdleSettingsError(`Unknown idle rule "${key}"`);
      if (override.enabled !== undefined && typeof override.enabled !== "boolean") {
        throw new IdleSettingsError(`rules["${key}"].enabled must be a boolean`);
      }
      for (const [tKey, value] of Object.entries(override.thresholds ?? {})) {
        const t = entry.rule.thresholds.find((d) => d.key === tKey);
        if (!t) throw new IdleSettingsError(`Unknown threshold "${tKey}" on rule "${key}"`);
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < t.min ||
          value > t.max
        ) {
          throw new IdleSettingsError(
            `rules["${key}"].thresholds.${tKey} must be a number from ${t.min} to ${t.max}`,
          );
        }
      }
    }
  }
}

/** Apply a patch and make every account in the org due for a re-scan. */
export async function updateOrgIdleSettings(
  organizationId: string,
  patch: IdleSettingsPatch,
  userId: string | null,
): Promise<IdleFindingSettings> {
  validateIdleSettingsPatch(patch, await declaredIdleRules());
  const current = await getOrgIdleSettings(organizationId);
  const next = normalizeIdleSettings({
    enabled: patch.enabled ?? current.enabled,
    lookbackDays: patch.lookbackDays ?? current.lookbackDays,
    rules: patch.rules ?? current.rules,
  });
  const values = { ...next, updatedByUserId: userId, updatedAt: new Date() };
  await db
    .insert(orgIdleFindingSettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: orgIdleFindingSettings.organizationId, set: values });
  await markOrgIdleScansDue(organizationId);
  return next;
}

/** Make every account of the org due now (settings changed, or a manual re-scan). */
export async function markOrgIdleScansDue(organizationId: string): Promise<void> {
  await db
    .update(accountIdlePolls)
    .set({ nextPollAt: sql`now()` })
    .where(eq(accountIdlePolls.organizationId, organizationId));
}

/** True when the org runs this rule. */
export function isIdleRuleEnabled(settings: IdleFindingSettings, ruleKey: string): boolean {
  return settings.enabled && settings.rules[ruleKey]?.enabled !== false;
}

/**
 * The rules one plugin should run for this org, with resolved thresholds:
 * what `fetchIdleFindings` receives as `request.rules`.
 */
export function idleRuleRequests(
  pluginId: string,
  declaration: IdleFindingsCapabilityDeclaration,
  settings: IdleFindingSettings,
): Record<string, IdleRuleRequest> {
  const out: Record<string, IdleRuleRequest> = {};
  for (const rule of declaration.rules) {
    const key = idleRuleKey(pluginId, rule.id);
    if (!isIdleRuleEnabled(settings, key)) continue;
    out[rule.id] = { thresholds: resolveIdleThresholds(rule, settings.rules[key]?.thresholds) };
  }
  return out;
}
