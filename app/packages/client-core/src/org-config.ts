/**
 * Org config as code — the one JSON document that carries an organization's
 * dashboards, workflows, custom graphs, budgets, alert rules and policies, and
 * the plan/apply contract for putting it back.
 *
 * This module is the shared pure half every surface uses: the document shape
 * the API exports and accepts, the plan shape the CLI and the settings section
 * render, and the key derivation both ends have to agree on. The zod schema
 * that validates an inbound document lives in the web package
 * (`web/src/services/org-config.ts`), which asserts against these types the way
 * `@infrawrench/ui/cost/config` asserts against `costs.ts`.
 *
 * **Keys, not ids.** Every entity in the document is addressed by a `key` — a
 * slug derived from its name — never by a database id. That is what makes one
 * document apply to a staging org, a fresh disaster-recovery org, and the org
 * it came from. Cross-references (a budget widget pointing at a budget, a
 * workflow with a budget trigger) are rewritten to keys on export and resolved
 * back to ids on apply.
 *
 * **What is deliberately not in here.** Accounts and their credentials (an
 * export must never be a credential leak), resources themselves (they belong to
 * the provider, not to us), workflow webhook signing secrets (write-only by
 * contract), and everything that is operational state rather than
 * configuration: firing history, cooldown claims, run logs, change freezes.
 */
import type { CostFilter, DashboardWidgetKind } from "./costs";
import type { TagPolicy } from "./tag-policy";

/** Document format version. Bumped only for a breaking document change. */
export const ORG_CONFIG_VERSION = 1;

/** Sections of the document, in the order a plan reports them. */
export const ORG_CONFIG_SECTIONS = [
  "budgets",
  "customGraphs",
  "workflows",
  "dashboards",
  "metricAlerts",
  "probes",
  "costCentres",
  "tagPolicy",
  "alertSettings",
] as const;

export type OrgConfigSection = (typeof ORG_CONFIG_SECTIONS)[number];

/** Human labels for the section ids, for CLI and settings rendering. */
export const ORG_CONFIG_SECTION_LABELS: Record<OrgConfigSection, string> = {
  budgets: "Budgets",
  customGraphs: "Custom graphs",
  workflows: "Workflows",
  dashboards: "Dashboards",
  metricAlerts: "Metric alerts",
  probes: "Synthetic probes",
  costCentres: "Cost centres",
  tagPolicy: "Tag policy",
  alertSettings: "Alert settings",
};

/**
 * The permission each section's writes require, on top of `config:write`.
 *
 * Apply checks both, so `config:write` cannot be used to reach past a role that
 * deliberately withholds (say) `workflows:write` — a document is only allowed to
 * touch the sections its caller could have edited by hand.
 */
export const ORG_CONFIG_SECTION_WRITE_PERMISSIONS: Record<OrgConfigSection, string> = {
  budgets: "budgets:write",
  customGraphs: "dashboards:write",
  workflows: "workflows:write",
  dashboards: "dashboards:write",
  metricAlerts: "metric-alerts:write",
  probes: "resources:write",
  costCentres: "costs:write",
  tagPolicy: "org:settings:write",
  alertSettings: "org:settings:write",
};

/** The permission each section's reads require, on top of `config:read`. */
export const ORG_CONFIG_SECTION_READ_PERMISSIONS: Record<OrgConfigSection, string> = {
  budgets: "budgets:read",
  customGraphs: "dashboards:read",
  workflows: "workflows:read",
  dashboards: "dashboards:read",
  metricAlerts: "metric-alerts:read",
  probes: "resources:read",
  costCentres: "costs:read",
  tagPolicy: "resources:read",
  alertSettings: "org:settings:write",
};

/* ----------------------------- document shape ----------------------------- */

/**
 * A workflow trigger as the document carries it. Mirrors the persisted
 * `workflows.trigger` jsonb except that a budget trigger names its budget by
 * document key rather than by row id — the one field that could not survive a
 * move between organizations.
 */
export type OrgConfigWorkflowTrigger =
  | { kind: "manual" }
  | { kind: "cron"; expression: string; timezone?: string | undefined }
  | {
      kind: "git";
      provider?: string | undefined;
      repo?: string | undefined;
      branch?: string | undefined;
      events?: string[] | undefined;
      /**
       * The GitHub App installation this trigger is bound to. Org-specific: it
       * survives a restore into the same org and is reported as an unresolved
       * reference when the target org has no such installation.
       */
      installationId?: number | undefined;
    }
  | {
      kind: "budget";
      /** `key` of an entry in this document's `budgets`. */
      budgetKey: string;
      percent?: number | undefined;
      metric?: ("actual" | "forecast") | undefined;
    };

/** A metric a workflow declares, as persisted in `workflows.metric_defs`. */
export interface OrgConfigWorkflowMetric {
  key: string;
  label: string;
  unit?: string | null | undefined;
  type?: string | undefined;
}

export interface OrgConfigWorkflow {
  key: string;
  name: string;
  description?: string | null | undefined;
  source: string;
  trigger: OrgConfigWorkflowTrigger;
  metrics: OrgConfigWorkflowMetric[];
  enabled: boolean;
}

export interface OrgConfigCustomGraph {
  key: string;
  name: string;
  description?: string | null | undefined;
  source: string;
}

export interface OrgConfigBudgetThreshold {
  type: "actual" | "forecast";
  percent: number;
}

export interface OrgConfigBudget {
  key: string;
  name: string;
  amountCents: number;
  currency: string;
  filters: CostFilter[];
  thresholds: OrgConfigBudgetThreshold[];
}

/** A dashboard card. Order in `cards` is the grid order (`gridX`). */
export type OrgConfigDashboardCard =
  | {
      kind: "widget";
      widgetKind: DashboardWidgetKind;
      title: string;
      /**
       * The widget config, minus any cross-entity id. A `budget` widget's
       * `budgetId` and a `custom_graph` widget's `graphId` are lifted out into
       * `budgetKey` / `graphKey` below and put back on apply.
       */
      config: Record<string, unknown>;
      budgetKey?: string | undefined;
      graphKey?: string | undefined;
      width?: number | undefined;
      height?: number | undefined;
    }
  | {
      kind: "workflow";
      /** `key` of an entry in this document's `workflows`. */
      workflowKey: string;
    }
  | {
      kind: "resource";
      /**
       * Resource pins name a live resource, which no document can create. The
       * triple below is resolved against the target org's synced resources on
       * apply; a pin that matches nothing is reported as an unresolved
       * reference and skipped, never invented.
       */
      pluginId: string;
      resourceTypeId: string;
      externalId: string;
      /** Display name of the account the resource was pinned from. */
      account: string;
      width?: number | undefined;
      height?: number | undefined;
    };

export interface OrgConfigDashboard {
  key: string;
  name: string;
  /** Exactly one dashboard in a document may be the default. */
  isDefault: boolean;
  cards: OrgConfigDashboardCard[];
}

export interface OrgConfigMetricAlert {
  key: string;
  name: string;
  pluginId: string | null;
  resourceTypeId: string | null;
  tagKey: string | null;
  tagValue: string | null;
  metricKey: string;
  comparator: ">" | ">=" | "<" | "<=";
  threshold: number;
  forMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
}

export interface OrgConfigProbe {
  key: string;
  name: string;
  url: string;
  method: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  enabled: boolean;
}

/** An allocation rule, nested under the centre it allocates to. */
export interface OrgConfigAllocationRule {
  priority: number;
  /** `AllocationRuleMatch`, except `accountId` is the account's display name. */
  match: {
    tagKey?: string | undefined;
    tagValue?: string | undefined;
    /** Account display name; resolved to an id on apply. */
    account?: string | undefined;
    pluginId?: string | undefined;
    service?: string | undefined;
  };
}

export interface OrgConfigCostCentre {
  key: string;
  name: string;
  description?: string | null | undefined;
  rules: OrgConfigAllocationRule[];
}

/** Everything under `alertSettings` — the org-wide notification tuning. */
export interface OrgConfigAlertSettings {
  costAnomaly?:
    | {
        sigmas: number;
        minDeltaCents: number;
        newSourceMinCents: number;
        smsAlerts: "off" | "new_source" | "all";
      }
    | undefined;
  drift?:
    | {
        notifyCreated: boolean;
        notifyUpdated: boolean;
        notifyDeleted: boolean;
        cooldownMinutes: number;
        minChanges: number;
        /** Account display names; an empty list means every account. */
        accounts: string[];
      }
    | undefined;
  expiry?: { enabled: boolean; leadDays: number } | undefined;
  posture?: { enabled: boolean } | undefined;
  digest?:
    | {
        enabled: boolean;
        timezone: string;
        sendDay: number;
        sendHour: number;
        narrativeEnabled: boolean;
        /** Email addresses the digest is routed to. */
        recipients: string[];
      }
    | undefined;
}

/**
 * Alert settings with every group present — what a *read* of the org returns,
 * since each group falls back to the shipped defaults when its row is missing.
 * The document's own type keeps them optional; only the export is total.
 */
export type OrgConfigAlertSettingsResolved = {
  [K in keyof OrgConfigAlertSettings]-?: NonNullable<OrgConfigAlertSettings[K]>;
};

/**
 * The exported document. Every section is optional: a document that omits a
 * section leaves it alone, in both merge and replace mode. That is what makes
 * a hand-written file naming only `budgets` a legal, safe thing to apply.
 */
export interface OrgConfigDocument {
  version: number;
  /** Provenance. Informational — ignored on apply. */
  exportedAt?: string | undefined;
  exportedFrom?: { organizationId: string; organizationName: string } | undefined;
  budgets?: OrgConfigBudget[] | undefined;
  customGraphs?: OrgConfigCustomGraph[] | undefined;
  workflows?: OrgConfigWorkflow[] | undefined;
  dashboards?: OrgConfigDashboard[] | undefined;
  metricAlerts?: OrgConfigMetricAlert[] | undefined;
  probes?: OrgConfigProbe[] | undefined;
  costCentres?: OrgConfigCostCentre[] | undefined;
  tagPolicy?: TagPolicy | undefined;
  alertSettings?: OrgConfigAlertSettings | undefined;
}

/* -------------------------------- plan shape ------------------------------ */

/**
 * How an apply treats entities the document does not mention.
 *
 * - `merge` (default) — create and update what the document names, leave
 *   everything else alone. Safe to run against a live org.
 * - `replace` — additionally delete entities in the sections the document
 *   *does* carry that it does not name. This is what makes a staging org a
 *   faithful copy, and it is why `--prune` is opt-in with a confirmation.
 */
export type OrgConfigApplyMode = "merge" | "replace";

export type OrgConfigAction = "create" | "update" | "delete" | "unchanged";

export interface OrgConfigChange {
  section: OrgConfigSection;
  key: string;
  /** The entity's display name, for rendering. */
  name: string;
  action: OrgConfigAction;
  /** Fields that differ, on an `update`. */
  fields?: string[] | undefined;
}

/**
 * Something the document asked for that the target org could not satisfy — a
 * resource pin for a resource nobody synced, a workflow's budget trigger naming
 * a budget the document does not define, a `replace` that would have deleted
 * the default dashboard. Never fatal on its own: the card, trigger or deletion
 * is dropped and the rest of the document still applies, so a restore is not
 * held hostage by one dangling pin.
 */
export interface OrgConfigUnresolved {
  section: OrgConfigSection;
  /** The entity that carried the reference. */
  key: string;
  /** What could not be found or done, in words. */
  detail: string;
}

export interface OrgConfigPlan {
  mode: OrgConfigApplyMode;
  changes: OrgConfigChange[];
  unresolved: OrgConfigUnresolved[];
  counts: Record<OrgConfigAction, number>;
}

/** The result of an apply — the plan that was executed. */
export interface OrgConfigApplyResult extends OrgConfigPlan {
  applied: boolean;
}

/** Tally a change list into the plan's counts. */
export function tallyOrgConfigChanges(changes: OrgConfigChange[]): Record<OrgConfigAction, number> {
  const counts: Record<OrgConfigAction, number> = {
    create: 0,
    update: 0,
    delete: 0,
    unchanged: 0,
  };
  for (const change of changes) counts[change.action] += 1;
  return counts;
}

/** True when a plan would change nothing. */
export function orgConfigPlanIsNoop(plan: OrgConfigPlan): boolean {
  return plan.counts.create + plan.counts.update + plan.counts.delete === 0;
}

/* --------------------------------- keys ----------------------------------- */

/** Longest a derived key may be — long enough to stay readable in a diff. */
export const ORG_CONFIG_KEY_MAX_LENGTH = 80;

/**
 * What a document key must look like: lowercase alphanumerics joined by single
 * hyphens. The API's zod schema and the published OpenAPI schema both use this
 * one definition, so a key the CLI would produce is never a key the server
 * refuses.
 */
export const ORG_CONFIG_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugify a display name into a document key: lowercase, non-alphanumerics
 * collapsed to single hyphens, trimmed. Names that slugify to nothing (an
 * emoji-only dashboard name, say) fall back to `"item"`, which the caller then
 * disambiguates.
 */
export function slugifyOrgConfigKey(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORG_CONFIG_KEY_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "item";
}

/**
 * A key for `name` that is not already in `taken`, adding `-2`, `-3`… as
 * needed, and recording it. Two dashboards genuinely called "Home" both need a
 * key, and the second one must not silently overwrite the first.
 */
export function uniqueOrgConfigKey(name: string, taken: Set<string>): string {
  const base = slugifyOrgConfigKey(name);
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Whether a string is usable as a document key (what the API validates). */
export function isValidOrgConfigKey(key: string): boolean {
  return ORG_CONFIG_KEY_PATTERN.test(key) && key.length <= ORG_CONFIG_KEY_MAX_LENGTH;
}
