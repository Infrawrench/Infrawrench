/**
 * The server half of a pull request check: take the changed files, find the
 * Terraform blocks they add, edit or remove, and answer for each one what it
 * costs and what depends on it.
 *
 * Every answer comes from a feature that already exists, through the same
 * function that feature's own surfaces call:
 *
 * - **Which synced resource a block manages**: IaC reconciliation
 *   (`runIacReconciliation`) over the org's uploaded Terraform state, scoped
 *   by the repository→state mapping GitHub issue filing already keeps
 *   (`iacSources`) when one names this repository, else every state scope
 *   with the rule that an address matching in two scopes matches nothing.
 * - **The plugin type of a new block**: the derived Terraform type map.
 * - **Its fields**: the derived attribute map (`deriveTerraformAttributeFieldMap`),
 *   the export mapper run backwards. Only literal attributes are read; a
 *   value set from a variable or expression is never guessed.
 * - **Cost**: `estimateResourceCost`, the create form's and edit modal's
 *   estimator. An existing resource is priced from its stored fields with
 *   the edited ones merged over them, exactly the edit modal's delta.
 * - **Blast radius**: `getBlastRadius`, the delete dialog's report, over one
 *   org-wide dependency graph loaded once for the whole check.
 * - **Warnings**: the cached right-sizing feed, the org tag policy's
 *   `tagPolicyViolations`, and `computePostureFindings` run on the stored
 *   fields before and after the edit.
 *
 * Nothing here throws for a partial answer: each gatherer that cannot answer
 * leaves a note or an `unpricedReason`, the way the blast-radius report keeps
 * `unchecked`. A check that fails to say something must say so.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  computePostureFindings,
  deriveTerraformAttributeFieldMap,
  postureFindingKey,
  tagPolicyViolations,
  terraformAttributesToFields,
  type BlastRadiusSeverity,
  type IacReconciliationEntry,
  type PrCheckBlastRadius,
  type PrCheckChange,
  type PrCheckEstimateSide,
  type PrCheckReport,
  type TerraformAttributeFieldMap,
} from "@infrawrench/client-core";
import type { CostEstimate } from "@infrawrench/plugin-base";

import { db } from "../db/client.js";
import { accounts, resources } from "../db/schema.js";
import { estimateResourceCost, stringifyFields } from "../cost/estimate.js";
import { getOrgTagPolicy } from "../cost/tag-policy.js";
import { getBlastRadius } from "../dependency-graph/blast-radius.js";
import { loadDependencyGraph } from "../dependency-graph/service.js";
import { getGithubIssueSettings } from "../github-issues/settings.js";
import { loadCapabilities, runIacReconciliation } from "../iac/service.js";
import { listIacStates } from "../iac/store.js";
import { loadPlugins } from "../plugin-loader.js";
import { listRightsizing } from "../savings/rightsizing.js";
import { diffInfrastructureFiles, type BlockChange, type PrCheckSourceFile } from "./diff.js";
import { blockCount, literalAttributes, type HclResourceBlock } from "./hcl-blocks.js";

export type { PrCheckSourceFile } from "./diff.js";

/** Changes priced per check: each is one or two provider pricing calls. */
const MAX_PRICED_CHANGES = 40;
/** Existing resources a check runs the full impact report for. */
const MAX_BLAST_RADIUS = 10;
/** One pricing call's budget; a slow pricing API costs a line, not the check. */
const ESTIMATE_TIMEOUT_MS = 20_000;

const SEVERITY_RANK: Record<BlastRadiusSeverity, number> = {
  none: 0,
  unknown: 1,
  low: 2,
  medium: 3,
  high: 4,
};

export interface AnalyzeOptions {
  /** `owner/name`, to narrow state scopes through GitHub issue filing's mapping. */
  repo?: string | null;
  /** Path prefixes to look in (the repository's configured directories). */
  directories?: readonly string[];
}

interface MatchedResource {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.()),
  ]);
}

function side(estimate: CostEstimate | null): PrCheckEstimateSide | null {
  return estimate
    ? {
        monthlyAmount: estimate.monthlyAmount,
        currency: estimate.currency,
        partial: Boolean(estimate.partial),
      }
    : null;
}

/** Strip a `[0]` / `["key"]` instance index from a state address. */
function baseAddress(address: string): string {
  return address.replace(/\[[^\]]*\]$/, "");
}

/**
 * Terraform address → managed resources, over the state scopes this
 * repository could be using. An address found in two scopes is dropped: a
 * guess between two accounts' resources is a wrong blast radius in front of
 * a reviewer.
 */
async function loadAddressIndex(
  organizationId: string,
  opts: AnalyzeOptions,
  directories: Set<string>,
  notes: string[],
): Promise<Map<string, MatchedResource[]>> {
  const index = new Map<string, MatchedResource[]>();
  const states = await listIacStates(organizationId).catch(() => []);
  if (states.length === 0) {
    notes.push(
      "No Terraform state has been uploaded under IaC, so existing resources could not be matched; edits and removals are priced from the code alone.",
    );
    return index;
  }

  // Newest document per scope (the list is newest first).
  const newest = new Map<string, (typeof states)[number]>();
  for (const s of states) if (!newest.has(s.accountId ?? "")) newest.set(s.accountId ?? "", s);

  let scopes = [...newest.values()];
  if (opts.repo) {
    const settings = await getGithubIssueSettings(organizationId).catch(() => null);
    const mapped = (settings?.iacSources ?? []).filter(
      (s) =>
        s.repo.fullName.toLowerCase() === opts.repo!.toLowerCase() &&
        (directories.size === 0 || directories.has(s.directory.replace(/^\/+|\/+$/g, ""))),
    );
    if (mapped.length > 0) {
      const wanted = new Set(mapped.map((m) => m.iacAccountId ?? ""));
      const narrowed = scopes.filter((s) => wanted.has(s.accountId ?? ""));
      if (narrowed.length > 0) scopes = narrowed;
    }
  }

  const owners = new Map<string, string>();
  for (const state of scopes) {
    let entries: IacReconciliationEntry[];
    try {
      entries = (await runIacReconciliation({ organizationId, stateId: state.id })).resources;
    } catch {
      notes.push(`The Terraform state "${state.label}" could not be read.`);
      continue;
    }
    for (const e of entries) {
      if (e.status === "unmanaged" || !e.terraformAddress) continue;
      const address = baseAddress(e.terraformAddress);
      const owner = owners.get(address);
      if (owner !== undefined && owner !== state.id) {
        index.set(address, []); // ambiguous across scopes: match nothing
        continue;
      }
      owners.set(address, state.id);
      const list = index.get(address) ?? [];
      list.push({
        resourceId: e.resourceId,
        pluginId: e.pluginId,
        resourceTypeId: e.resourceTypeId,
        accountId: e.accountId,
        displayName: e.displayName,
      });
      index.set(address, list);
    }
  }
  return index;
}

/** The org's oldest live account per plugin: what a new block is priced through. */
async function loadPricingAccounts(organizationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)))
    .orderBy(asc(accounts.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.pluginId)) out.set(r.pluginId, r.id);
  return out;
}

/** Analyse a set of changed files. Never throws for a partial answer. */
export async function analyzePrCheck(
  organizationId: string,
  input: readonly PrCheckSourceFile[],
  opts: AnalyzeOptions = {},
): Promise<PrCheckReport> {
  const diff = diffInfrastructureFiles(input, opts.directories ?? []);
  const notes = [...diff.notes];
  const report: PrCheckReport = {
    generatedAt: new Date().toISOString(),
    files: diff.files,
    changes: [],
    totals: {
      monthlyDelta: null,
      currency: null,
      partial: false,
      pricedChanges: 0,
      unpricedChanges: 0,
      otherCurrencyChanges: 0,
    },
    blast: { touchedResources: 0, dependants: 0, highestSeverity: null },
    notes,
    truncated: diff.truncated,
  };
  if (diff.changes.length === 0) {
    if (diff.files.some((f) => f.kind === "terraform")) {
      notes.push("The Terraform files changed, but no resource block did.");
    }
    return report;
  }

  const { capabilityFor, typeMap } = await loadCapabilities();
  const plugins = await loadPlugins();
  const pluginById = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin] as const));
  const directories = new Set(diff.changes.map((c) => c.directory));
  const [addressIndex, pricingAccounts] = await Promise.all([
    loadAddressIndex(organizationId, opts, directories, notes),
    loadPricingAccounts(organizationId),
  ]);

  const attributeMaps = new Map<string, TerraformAttributeFieldMap>();
  const attributeMap = (pluginId: string, typeId: string) => {
    const key = `${pluginId}/${typeId}`;
    let map = attributeMaps.get(key);
    if (!map) {
      map = deriveTerraformAttributeFieldMap(capabilityFor(pluginId), pluginId, typeId);
      attributeMaps.set(key, map);
    }
    return map;
  };
  const fieldsOf = (pluginId: string, typeId: string, block: HclResourceBlock | null) =>
    block
      ? terraformAttributesToFields(attributeMap(pluginId, typeId), literalAttributes(block))
      : {};

  let pricedSoFar = 0;
  const estimate = async (args: {
    accountId: string;
    resourceTypeId: string;
    fields?: Record<string, string>;
    resourceId?: string;
  }) => {
    pricedSoFar++;
    return withTimeout(
      estimateResourceCost(organizationId, args).catch(() => null),
      ESTIMATE_TIMEOUT_MS,
    );
  };

  // --- per-change matching and pricing ---
  const changes: PrCheckChange[] = [];
  for (const c of diff.changes) {
    const lookup = c.movedFrom ?? c.address;
    const matches = c.action === "create" ? [] : (addressIndex.get(lookup) ?? []);
    const matched = matches.length === 1 ? matches[0]! : null;
    const mappings = typeMap.byTerraformType.get(c.terraformType) ?? [];
    const typed = matched
      ? { pluginId: matched.pluginId, resourceTypeId: matched.resourceTypeId }
      : mappings.length === 1
        ? mappings[0]!
        : null;
    const count = blockCount((c.after ?? c.before)!);
    const change: PrCheckChange = {
      address: c.address,
      terraformType: c.terraformType,
      action: c.action,
      path: c.path,
      line: c.line,
      resourceId: matched?.resourceId ?? null,
      displayName:
        matched?.displayName ?? (matches.length > 1 ? `${matches.length} instances` : null),
      pluginId: typed?.pluginId ?? null,
      resourceTypeId: typed?.resourceTypeId ?? null,
      changedAttributes: c.changedAttributes,
      count,
      before: null,
      after: null,
      monthlyDelta: null,
      currency: null,
      unpricedReason: null,
      blastRadius: null,
      warnings: [],
    };

    if (!typed) {
      change.unpricedReason =
        mappings.length > 1
          ? `${c.terraformType} maps to several Infrawrench resource types, so the check will not pick one.`
          : `No connected provider describes ${c.terraformType}.`;
    } else if (pricedSoFar >= MAX_PRICED_CHANGES * 2) {
      change.unpricedReason = "Not priced: the check prices at most 40 changes.";
      report.truncated = true;
    } else {
      const accountId = matched?.accountId ?? pricingAccounts.get(typed.pluginId) ?? null;
      if (!accountId) {
        change.unpricedReason = `No ${pluginById.get(typed.pluginId)?.manifest.displayName ?? typed.pluginId} account is connected to price it through.`;
      } else {
        await priceChange(change, c, matched, accountId, typed.resourceTypeId, fieldsOf, estimate);
      }
    }
    changes.push(change);
  }

  // --- blast radius over the existing resources the change touches ---
  const touched = changes.filter((c) => c.resourceId && c.action !== "create");
  report.blast.touchedResources = touched.length;
  if (touched.length > 0) {
    const graph = await loadDependencyGraph(organizationId, null).catch(() => null);
    if (!graph) notes.push("The dependency graph could not be loaded, so blast radius is unknown.");
    if (touched.length > MAX_BLAST_RADIUS) {
      notes.push(
        `Blast radius was checked for the first ${MAX_BLAST_RADIUS} existing resources only.`,
      );
      report.truncated = true;
    }
    for (const c of touched.slice(0, MAX_BLAST_RADIUS)) {
      if (!graph) break;
      const radius = await getBlastRadius(organizationId, c.resourceId!, { graph }).catch(
        () => null,
      );
      if (!radius) continue;
      const summary: PrCheckBlastRadius = {
        directDependants: radius.directCount,
        transitiveDependants: radius.transitiveCount,
        references: radius.references.length,
        severity: radius.severity,
        headline: radius.headline,
        topDependants: radius.dependants
          .filter((d) => d.depth === 1)
          .slice(0, 5)
          .map((d) => d.node.displayName),
        unchecked: radius.unchecked.length,
      };
      c.blastRadius = summary;
      report.blast.dependants += radius.directCount + radius.transitiveCount;
      const prev = report.blast.highestSeverity;
      if (!prev || SEVERITY_RANK[radius.severity] > SEVERITY_RANK[prev]) {
        report.blast.highestSeverity = radius.severity;
      }
    }
  }

  await addWarnings(organizationId, changes, diff.changes, pluginById, fieldsOf, notes);

  for (const { path, message } of diff.parseErrors) {
    notes.push(`${path}: ${message}`);
  }

  report.changes = changes;
  report.totals = totalsOf(changes);
  return report;
}

async function priceChange(
  change: PrCheckChange,
  c: BlockChange,
  matched: MatchedResource | null,
  accountId: string,
  resourceTypeId: string,
  fieldsOf: (
    pluginId: string,
    typeId: string,
    block: HclResourceBlock | null,
  ) => Record<string, string>,
  estimate: (args: {
    accountId: string;
    resourceTypeId: string;
    fields?: Record<string, string>;
    resourceId?: string;
  }) => Promise<CostEstimate | null>,
): Promise<void> {
  const pluginId = change.pluginId!;
  const beforeFields = fieldsOf(pluginId, resourceTypeId, c.before);
  const afterFields = fieldsOf(pluginId, resourceTypeId, c.after);

  let before: CostEstimate | null = null;
  let after: CostEstimate | null = null;
  let beforeKnown = c.action === "create";
  let afterKnown = c.action === "delete";

  if (c.action !== "create") {
    before = matched
      ? await estimate({ accountId, resourceTypeId, resourceId: matched.resourceId })
      : await estimate({ accountId, resourceTypeId, fields: beforeFields });
    beforeKnown = before !== null;
  }
  if (c.action !== "delete") {
    if (matched) {
      // The edit modal's rule: only the keys that changed, merged over the
      // stored fields, so attributes the code does not set keep their value.
      const changedFields: Record<string, string> = {};
      for (const [key, value] of Object.entries(afterFields)) {
        if (beforeFields[key] !== value) changedFields[key] = value;
      }
      after = await estimate({
        accountId,
        resourceTypeId,
        resourceId: matched.resourceId,
        fields: changedFields,
      });
    } else {
      after = await estimate({ accountId, resourceTypeId, fields: afterFields });
    }
    afterKnown = after !== null;
  }

  change.before = side(before);
  change.after = side(after);
  if (!beforeKnown || !afterKnown) {
    change.unpricedReason =
      Object.keys(c.action === "delete" ? beforeFields : afterFields).length === 0 && !matched
        ? "None of the block's attributes are literals the provider's price list is keyed by."
        : "The provider's pricing did not return a rate for this configuration.";
    return;
  }
  const currencies = new Set([before?.currency, after?.currency].filter(Boolean));
  if (currencies.size > 1) {
    change.unpricedReason = "The two sides were priced in different currencies.";
    return;
  }
  const delta = (after?.monthlyAmount ?? 0) - (before?.monthlyAmount ?? 0);
  if (change.count === null) {
    change.unpricedReason =
      "The block uses for_each or a computed count, so how many instances it makes is unknown until plan.";
    return;
  }
  change.monthlyDelta = Number((delta * change.count).toFixed(2));
  change.currency = (after?.currency ?? before?.currency)!;
}

export function totalsOf(changes: readonly PrCheckChange[]): PrCheckReport["totals"] {
  const byCurrency = new Map<string, { amount: number; count: number }>();
  let unpriced = 0;
  let partial = false;
  for (const c of changes) {
    if (c.monthlyDelta === null || !c.currency) {
      unpriced++;
      continue;
    }
    if (c.before?.partial || c.after?.partial) partial = true;
    const entry = byCurrency.get(c.currency) ?? { amount: 0, count: 0 };
    entry.amount += c.monthlyDelta;
    entry.count++;
    byCurrency.set(c.currency, entry);
  }
  const ranked = [...byCurrency.entries()].sort((a, b) => b[1].count - a[1].count);
  const winner = ranked[0];
  const other = ranked.slice(1).reduce((n, [, e]) => n + e.count, 0);
  return {
    monthlyDelta: winner ? Number(winner[1].amount.toFixed(2)) : null,
    currency: winner?.[0] ?? null,
    partial: partial || unpriced > 0 || other > 0,
    pricedChanges: winner?.[1].count ?? 0,
    unpricedChanges: unpriced,
    otherCurrencyChanges: other,
  };
}

const TAG_ATTRIBUTES = ["tags", "labels"] as const;

async function addWarnings(
  organizationId: string,
  changes: PrCheckChange[],
  blocks: readonly BlockChange[],
  pluginById: Map<string, Awaited<ReturnType<typeof loadPlugins>>[number]["plugin"]>,
  fieldsOf: (
    pluginId: string,
    typeId: string,
    block: HclResourceBlock | null,
  ) => Record<string, string>,
  notes: string[],
): Promise<void> {
  // Tag policy: literal tag maps on created or edited blocks.
  const policy = await getOrgTagPolicy(organizationId).catch(() => null);
  if (policy && policy.requiredTags.length > 0) {
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]!;
      const block = blocks[i]!.after;
      if (!block || change.action === "delete") continue;
      const attr = TAG_ATTRIBUTES.find((a) => block.attributes[a]);
      const value = attr ? block.attributes[attr] : undefined;
      if (!value) {
        if (change.action !== "create") continue;
        change.warnings.push({
          kind: "tag-policy",
          severity: "notice",
          message: `Sets no tags; the org's tag policy requires ${policy.requiredTags.map((t) => t.key).join(", ")} (provider-level default tags are not visible to this check).`,
        });
        continue;
      }
      if (value.kind !== "map") {
        change.warnings.push({
          kind: "tag-policy",
          severity: "notice",
          message: `${attr} is set from an expression, so the tag policy could not be checked.`,
        });
        continue;
      }
      const violations = tagPolicyViolations(value.entries, policy.requiredTags);
      if (violations.length > 0) {
        change.warnings.push({
          kind: "tag-policy",
          severity: "warning",
          message: `Tag policy: ${violations
            .map((v) =>
              v.reason === "missing"
                ? `missing "${v.key}"`
                : `"${v.key}" is "${v.value ?? ""}" (allowed: ${(v.allowedValues ?? []).join(", ")})`,
            )
            .join("; ")}.`,
        });
      }
    }
  }

  const edited = changes
    .map((c, i) => ({ change: c, block: blocks[i]! }))
    .filter((x) => x.change.action === "update" && x.change.resourceId);
  if (edited.length === 0) return;

  // Right-sizing: an edit to a flagged resource's size that is not the
  // recommendation. Reads the cached feed; never recomputes it for a check.
  try {
    const rightsizing = await listRightsizing(organizationId);
    const flagged = new Map(
      rightsizing.accounts.flatMap((g) => g.resources).map((r) => [r.id, r] as const),
    );
    for (const { change, block } of edited) {
      const finding = flagged.get(change.resourceId!);
      if (!finding || !change.pluginId || !change.resourceTypeId) continue;
      const decl = pluginById
        .get(change.pluginId)
        ?.resourceTypes.find((t) => t.id === change.resourceTypeId)?.rightsizing;
      if (!decl) continue;
      const afterSize = fieldsOf(change.pluginId, change.resourceTypeId, block.after)[
        decl.sizeFieldKey
      ];
      const beforeSize = fieldsOf(change.pluginId, change.resourceTypeId, block.before)[
        decl.sizeFieldKey
      ];
      if (!afterSize || afterSize === beforeSize) continue;
      if (afterSize === finding.recommendedSize.id) {
        change.warnings.push({
          kind: "rightsizing",
          severity: "notice",
          message: `Matches the right-sizing recommendation (${finding.recommendedSize.label}).`,
        });
      } else {
        change.warnings.push({
          kind: "rightsizing",
          severity: "warning",
          message: `Infrawrench flags this resource as oversized (p95 CPU ${finding.cpuP95}% over ${rightsizing.windowDays} days) and recommends ${finding.recommendedSize.label}; this change sets ${afterSize}.`,
        });
      }
    }
  } catch {
    notes.push("Right-sizing recommendations could not be read.");
  }

  // Posture: rules the edited fields start matching.
  try {
    const ids = edited.map((x) => x.change.resourceId!);
    const rows = await db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, ids)));
    const accountRows = await db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId));
    const scanPlugins = [...pluginById.values()].map((p) => ({
      id: p.manifest.id,
      displayName: p.manifest.displayName,
      resourceTypes: p.resourceTypes,
    }));
    const base = rows.map((r) => ({
      id: r.id,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      accountId: r.accountId,
      displayName: r.displayName,
      externalId: r.externalId,
      parentResourceId: null,
      fields: r.fieldsJson,
    }));
    const proposed = base.map((r) => {
      const x = edited.find((e) => e.change.resourceId === r.id)!;
      const beforeFields = fieldsOf(r.pluginId, r.resourceTypeId, x.block.before);
      const afterFields = fieldsOf(r.pluginId, r.resourceTypeId, x.block.after);
      const changed: Record<string, string> = {};
      for (const [k, v] of Object.entries(afterFields)) if (beforeFields[k] !== v) changed[k] = v;
      return { ...r, fields: { ...stringifyFields(r.fields), ...changed } };
    });
    const input = { plugins: scanPlugins, accounts: accountRows };
    const now = computePostureFindings({ ...input, resources: base });
    const then = computePostureFindings({ ...input, resources: proposed });
    const existing = new Set(now.findings.map(postureFindingKey));
    for (const f of then.findings) {
      if (existing.has(postureFindingKey(f))) continue;
      const change = edited.find((e) => e.change.resourceId === f.resourceId)?.change;
      change?.warnings.push({
        kind: "posture",
        severity: "warning",
        message: `Posture: ${f.title} (${f.severity}). ${f.reason}`,
      });
    }
  } catch {
    notes.push("Posture rules could not be evaluated.");
  }
}
