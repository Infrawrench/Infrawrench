/**
 * Idle-rule tuning (`/api/org/:orgId/idle-findings*`).
 *
 * The findings themselves are rows of `GET /orphans` (an `OrphanedResource`
 * with `idle` set); these routes are the part a person tunes: which
 * metric-based rules run, their thresholds and the lookback window, plus a
 * re-scan and the per-account collection status that explains an empty list.
 *
 * The overview reads under `resources:read`, like the findings it explains.
 * Writing the settings and forcing a re-scan are `org:settings:write`, the
 * extended-support settings' permission: they decide what the whole org's
 * savings list says, and a re-scan spends metric reads on the customer's own
 * cloud bill.
 */
import { Hono } from "hono";
import {
  getOrgIdleSettings,
  IdleSettingsError,
  markOrgIdleScansDue,
  updateOrgIdleSettings,
  type IdleSettingsPatch,
} from "@infrawrench/server-core/idle/settings";
import { getIdleFindingsOverview } from "@infrawrench/server-core/idle/feed";
import type { IdleRuleOverride } from "@infrawrench/client-core";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { readObjectBody } from "../object-body";

const app = new Hono();

/** GET /: settings, every declared rule with its effective thresholds, per-account status. */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getIdleFindingsOverview(c.get("organizationId")));
});

app.get("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(await getOrgIdleSettings(c.get("organizationId")));
});

/** Shape-check the `rules` map; the bounds are the settings module's (it knows the declarations). */
function parseRules(raw: unknown): Record<string, IdleRuleOverride> | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "rules must be an object";
  const out: Record<string, IdleRuleOverride> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return `rules["${key}"] must be an object`;
    }
    const v = value as Record<string, unknown>;
    for (const k of Object.keys(v)) {
      if (k !== "enabled" && k !== "thresholds") return `rules["${key}"].${k} is not a setting`;
    }
    const entry: IdleRuleOverride = {};
    if (v["enabled"] !== undefined) {
      if (typeof v["enabled"] !== "boolean") return `rules["${key}"].enabled must be a boolean`;
      entry.enabled = v["enabled"];
    }
    if (v["thresholds"] !== undefined) {
      const t = v["thresholds"];
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        return `rules["${key}"].thresholds must be an object`;
      }
      const thresholds: Record<string, number> = {};
      for (const [tk, tv] of Object.entries(t as Record<string, unknown>)) {
        if (typeof tv !== "number") return `rules["${key}"].thresholds.${tk} must be a number`;
        thresholds[tk] = tv;
      }
      entry.thresholds = thresholds;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * PUT /settings: every field optional, so one switch can be saved alone.
 * `rules`, when sent, replaces the whole overrides map (a rule left out runs
 * with its defaults). Out-of-range values are rejected, not clamped. Any
 * change makes every account due for a fresh collection.
 */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  const patch: IdleSettingsPatch = {};
  for (const key of Object.keys(body)) {
    if (key !== "enabled" && key !== "lookbackDays" && key !== "rules") {
      return c.json({ error: `${key} is not a setting` }, 400);
    }
  }
  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    patch.enabled = body["enabled"];
  }
  if (body["lookbackDays"] !== undefined) {
    if (typeof body["lookbackDays"] !== "number") {
      return c.json({ error: "lookbackDays must be a number" }, 400);
    }
    patch.lookbackDays = body["lookbackDays"];
  }
  if (body["rules"] !== undefined) {
    const rules = parseRules(body["rules"]);
    if (typeof rules === "string") return c.json({ error: rules }, 400);
    patch.rules = rules;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No settings supplied" }, 400);
  try {
    const saved = await updateOrgIdleSettings(
      organizationId,
      patch,
      c.get("session")?.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId,
      action: "idle_findings.settings_update",
      entityType: "organization",
      entityId: organizationId,
      metadata: {
        enabled: saved.enabled,
        lookbackDays: saved.lookbackDays,
        ruleOverrides: Object.keys(saved.rules).length,
      },
    });
    return c.json(saved);
  } catch (err) {
    if (err instanceof IdleSettingsError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/** POST /rescan: make every account due on the next poller tick. */
app.post("/rescan", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  await markOrgIdleScansDue(organizationId);
  void logAudit({
    organizationId,
    userId: c.get("session")?.userId,
    action: "idle_findings.rescan",
    entityType: "organization",
    entityId: organizationId,
  });
  return c.json({ ok: true });
});

export { app as idleFindingRoutes };
