/**
 * The credential-preflight contract, shared by every client that renders the
 * per-capability checklist: what a plugin declared it can do, what the probe
 * found the credential can actually do, and the pure helper that merges the
 * two into renderable rows.
 *
 * It lives here rather than in `@infrawrench/ui` for the same reason the cost
 * contract does — mobile doesn't depend on that package. The declaration types
 * come straight from `@infrawrench/plugin-base` so a plugin-side change fails
 * this build instead of drifting silently.
 */

import type {
  Plugin,
  PluginClient,
  PolicyTemplate,
  PreflightCapability,
  PreflightDeclaration,
  PreflightPermission,
} from "@infrawrench/plugin-base";

export type {
  PolicyTemplate,
  PreflightCapability,
  PreflightDeclaration,
  PreflightPermission,
} from "@infrawrench/plugin-base";

/** One capability's probe outcome, as it crosses the wire. */
export interface PreflightCheck {
  capabilityId: string;
  status: "ok" | "missing" | "unknown";
  /** Permissions the probe found absent — only meaningful when `missing`. */
  missingPermissions: PreflightPermission[];
  message: string | null;
  /** Provider console page that fixes it, when the plugin knows one. */
  helpLink: { label: string; url: string } | null;
}

/** Everything a preflight run reports back (`POST .../preflight`). */
export interface PreflightReport {
  pluginId: string;
  /** False when the plugin declares no preflight — the UI hides the feature. */
  supported: boolean;
  /** Provider-side identity the credential resolved to, when known. */
  identity: string | null;
  checks: PreflightCheck[];
}

/** One renderable checklist row: declaration merged with probe outcome. */
export interface PreflightChecklistRow {
  capability: PreflightCapability;
  /** `unchecked` = declared but the probe returned nothing for it. */
  status: "ok" | "missing" | "unknown" | "unchecked";
  /**
   * For `missing` rows: the permissions to list. When the probe couldn't say
   * which specific permissions failed, this falls back to everything the
   * capability declared — the user still sees what to grant.
   */
  missingPermissions: PreflightPermission[];
  message: string | null;
  helpLink: { label: string; url: string } | null;
}

/**
 * Merge a plugin's declared capabilities with a probe report into rows the
 * checklist renders, in declaration order. Rows for capabilities the probe
 * never mentioned come back `unchecked`; checks for capabilities the plugin
 * no longer declares are dropped (stale client vs. newer plugin).
 */
export function buildPreflightChecklist(
  declaration: PreflightDeclaration,
  report: PreflightReport | null,
): PreflightChecklistRow[] {
  const byCapability = new Map<string, PreflightCheck>();
  for (const check of report?.checks ?? []) {
    if (!byCapability.has(check.capabilityId)) byCapability.set(check.capabilityId, check);
  }
  return declaration.capabilities.map((capability) => {
    const check = byCapability.get(capability.id);
    if (!check) {
      return {
        capability,
        status: "unchecked",
        missingPermissions: [],
        message: null,
        helpLink: null,
      };
    }
    return {
      capability,
      status: check.status,
      missingPermissions:
        check.status === "missing"
          ? check.missingPermissions.length > 0
            ? check.missingPermissions
            : capability.requiredPermissions
          : [],
      message: check.message ?? null,
      helpLink: check.helpLink ?? null,
    };
  });
}

/** Counts for the checklist's one-line summary ("2 of 3 capabilities ready"). */
export interface PreflightSummary {
  total: number;
  ok: number;
  missing: number;
  unknown: number;
  /** True when a capability marked `essential` is missing. */
  essentialMissing: boolean;
}

export function summarizePreflight(rows: PreflightChecklistRow[]): PreflightSummary {
  const summary: PreflightSummary = {
    total: rows.length,
    ok: 0,
    missing: 0,
    unknown: 0,
    essentialMissing: false,
  };
  for (const row of rows) {
    if (row.status === "ok") summary.ok++;
    else if (row.status === "missing") {
      summary.missing++;
      if (row.capability.essential) summary.essentialMissing = true;
    } else summary.unknown++;
  }
  return summary;
}

/**
 * The capability ids a policy-template picker should start with: everything
 * declared. The user narrows from there — least privilege is about what they
 * deselect, and starting full mirrors what the plugin can actually use.
 */
export function defaultTemplateCapabilityIds(declaration: PreflightDeclaration): string[] {
  return declaration.capabilities.map((c) => c.id);
}

/** Long enough for provider guidance, short enough to render inline. */
const MAX_MESSAGE_CHARS = 600;

function clampMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_MESSAGE_CHARS
    ? `${trimmed.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : trimmed;
}

/** Only ever hand the UI a link it can safely render as an anchor. */
function sanitizeHelpLink(raw: unknown): { label: string; url: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { label, url } = raw as { label?: unknown; url?: unknown };
  if (typeof label === "string" && typeof url === "string" && url.startsWith("https://")) {
    return { label, url };
  }
  return null;
}

/**
 * Run a plugin's credential preflight and normalize the outcome into the
 * wire shape the checklist renders. Hosted here (not in server code) because
 * every host runs it: the web server against stored/submitted credentials,
 * the desktop renderer against its local plugin clients.
 *
 * Never throws:
 *   - No `preflight` declaration → `supported: false`.
 *   - Declared but no `verifyCredentials` implementation, a thrown probe, or
 *     a capability the probe skipped → `unknown` checks, so a partial or
 *     absent probe still renders a complete checklist.
 *
 * Strings are bounded and help links are only ever safe https anchors — the
 * same discipline `describeCostFailure` applies to cost-collection errors
 * (plugins are semi-trusted: bundled, but versioned separately).
 */
export async function runAccountPreflight(
  plugin: Plugin,
  client: PluginClient,
): Promise<PreflightReport> {
  const pluginId = plugin.manifest.id;
  const declaration = plugin.manifest.preflight;
  if (!declaration) {
    return { pluginId, supported: false, identity: null, checks: [] };
  }

  const declaredIds = declaration.capabilities.map((c) => c.id);
  const unknownCheck = (capabilityId: string, message: string | null): PreflightCheck => ({
    capabilityId,
    status: "unknown",
    missingPermissions: [],
    message,
    helpLink: null,
  });

  if (!client.verifyCredentials) {
    return {
      pluginId,
      supported: true,
      identity: null,
      checks: declaredIds.map((id) =>
        unknownCheck(id, "This plugin does not implement a credential probe yet."),
      ),
    };
  }

  let identity: string | null = null;
  const byCapability = new Map<string, PreflightCheck>();
  try {
    const result = await client.verifyCredentials();
    identity = clampMessage(result.identity);
    for (const check of result.checks) {
      if (!declaredIds.includes(check.capabilityId)) continue;
      if (byCapability.has(check.capabilityId)) continue;
      if (check.status === "ok") {
        byCapability.set(check.capabilityId, {
          capabilityId: check.capabilityId,
          status: "ok",
          missingPermissions: [],
          message: null,
          helpLink: null,
        });
      } else if (check.status === "missing") {
        byCapability.set(check.capabilityId, {
          capabilityId: check.capabilityId,
          status: "missing",
          missingPermissions: Array.isArray(check.missingPermissions)
            ? check.missingPermissions
                .filter((p) => typeof p?.id === "string" && typeof p?.label === "string")
                .map((p) => ({ id: p.id, label: p.label }))
            : [],
          message: clampMessage(check.message),
          helpLink: sanitizeHelpLink(check.helpLink),
        });
      } else {
        byCapability.set(
          check.capabilityId,
          unknownCheck(check.capabilityId, clampMessage(check.message)),
        );
      }
    }
  } catch (e) {
    const message =
      clampMessage(e instanceof Error ? e.message : String(e)) ?? "Credential probe failed";
    return {
      pluginId,
      supported: true,
      identity: null,
      checks: declaredIds.map((id) => unknownCheck(id, message)),
    };
  }

  return {
    pluginId,
    supported: true,
    identity,
    checks: declaredIds.map(
      (capabilityId) =>
        byCapability.get(capabilityId) ??
        unknownCheck(capabilityId, "The probe returned no verdict for this capability."),
    ),
  };
}
