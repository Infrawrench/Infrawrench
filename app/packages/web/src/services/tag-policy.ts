import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import type { PluginClient } from "@infrawrench/plugin-base";
import {
  TAG_POLICY_OVERRIDE_HEADER,
  TAG_POLICY_UNMET_CODE,
  complianceScore,
  describeTagViolations,
  extractRecordTags,
  fieldsDeclareTagField,
  tagPolicyViolations,
  type AccountTagCompliance,
  type TagPolicy,
  type TagPolicyViolation,
} from "@infrawrench/client-core";
import type { UntaggedSpendReport } from "@infrawrench/client-core";
import { getOrgTagPolicy } from "@infrawrench/server-core/cost/tag-policy";
import { getUntaggedSpend } from "@infrawrench/server-core/clickhouse/cost-readers";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { logAudit } from "./audit";

/**
 * Create-time enforcement of the org tag policy, in the same shape as the
 * change-freeze gate (`services/change-freezes.ts`): a `check*` function the
 * route calls before touching the provider, which returns null to proceed or
 * a 4xx `Response` to refuse, with an override header gated on a dedicated
 * permission and both blocks and overrides audit-logged.
 *
 * The freeze speaks 423 (the org is locked); this speaks 422 (the request is
 * missing something the org requires). Same protocol, different verdict.
 */

export { TAG_POLICY_OVERRIDE_HEADER, TAG_POLICY_UNMET_CODE };

/** JSON body of the 422 returned when the tag policy blocks a create. */
export function tagPolicyBlockedPayload(policy: TagPolicy, violations: TagPolicyViolation[]) {
  return {
    error:
      `Organization tag policy not met: ${describeTagViolations(violations)}. ` +
      `Add the required tags, or retry with the "${TAG_POLICY_OVERRIDE_HEADER}: true" header ` +
      `if you hold tag-policy:override.`,
    code: TAG_POLICY_UNMET_CODE,
    violations,
    requiredTags: policy.requiredTags,
  };
}

/**
 * Whether the plugin's create form for this type declares a tag-capable field
 * (`tags` / `labels`). Only consulted when the submitted fields carry no tag
 * field at all — the extra provider round-trip is confined to enforcing orgs.
 * Unresolvable configs are treated as tag-incapable (the convention is
 * opt-in), the same fail-open stance as `isActionDestructive`.
 */
async function createConfigDeclaresTagField(
  client: PluginClient,
  resourceTypeId: string,
  parentResourceId: string | undefined,
): Promise<boolean> {
  if (!client.getCreateConfig) return false;
  try {
    const config = await client.getCreateConfig(resourceTypeId, parentResourceId);
    return fieldsDeclareTagField(config.fields ?? []);
  } catch {
    return false;
  }
}

interface TagPolicyCreateTarget {
  client: PluginClient;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  parentResourceId?: string | undefined;
  /** The resolved create fields, as they will be passed to the plugin. */
  fields: Record<string, string>;
}

/**
 * Enforce the org's tag policy on a resource create.
 *
 * Returns null when the request may proceed: no policy, enforcement off, the
 * type cannot carry tags (neither the submitted fields nor the plugin's create
 * config declare a `tags`/`labels` field), the tags satisfy the policy, or an
 * authorized explicit override (audit-logged). Returns a 422 `Response`
 * describing the violations when the create must be refused; the block is
 * audit-logged too. Call it after resolving the account/client and before
 * calling the plugin's `createResource`.
 */
export async function checkTagPolicyOnCreate(
  c: Context,
  target: TagPolicyCreateTarget,
): Promise<Response | null> {
  const organizationId = c.get("organizationId");
  const policy = await getOrgTagPolicy(organizationId);
  if (!policy.enforceOnCreate || policy.requiredTags.length === 0) return null;

  let tags = extractRecordTags(target.fields);
  if (tags === null) {
    const capable = await createConfigDeclaresTagField(
      target.client,
      target.resourceTypeId,
      target.parentResourceId,
    );
    if (!capable) return null;
    tags = {};
  }

  const violations = tagPolicyViolations(tags, policy.requiredTags);
  if (violations.length === 0) return null;

  const session = c.get("session") as { userId?: string } | undefined;
  const userId = session?.userId;
  const baseMeta = {
    pluginId: target.pluginId,
    resourceTypeId: target.resourceTypeId,
    accountId: target.accountId,
    violations: violations.map((v) => ({ key: v.key, reason: v.reason })),
  };

  const overrideRequested = c.req.header(TAG_POLICY_OVERRIDE_HEADER)?.toLowerCase() === "true";
  if (overrideRequested) {
    const granted = (c.get("permissions") ?? []) as readonly string[];
    if (hasPermission(granted, "tag-policy:override")) {
      void logAudit({
        organizationId,
        userId,
        action: "tag_policy.override",
        entityType: "resource",
        entityId: target.resourceTypeId,
        metadata: baseMeta,
      });
      return null;
    }
    // An override attempt without the permission is still a block — record it.
  }

  void logAudit({
    organizationId,
    userId,
    action: "tag_policy.block",
    entityType: "resource",
    entityId: target.resourceTypeId,
    metadata: { ...baseMeta, overrideRequested },
  });
  return c.json(tagPolicyBlockedPayload(policy, violations), 422);
}

/**
 * Untagged spend over the org's required tag keys, with account display
 * labels resolved. When the org has no required tags the report is empty —
 * "untagged" is only meaningful against a policy.
 */
export async function getUntaggedSpendReport(
  organizationId: string,
  from: string,
  to: string,
): Promise<UntaggedSpendReport> {
  const policy = await getOrgTagPolicy(organizationId);
  const requiredKeys = policy.requiredTags.map((t) => t.key);
  const rows = await getUntaggedSpend(organizationId, requiredKeys, from, to);

  const accountRows = await db
    .select({ id: accounts.id, displayName: accounts.displayName })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId));
  const accountNames = new Map(accountRows.map((r) => [r.id, r.displayName]));

  const totals: Record<string, number> = {};
  const untaggedTotals: Record<string, number> = {};
  for (const row of rows.totals) {
    totals[row.currency] = row.total;
    untaggedTotals[row.currency] = row.untagged;
  }

  const byKeyMap = new Map<string, Record<string, number>>();
  for (const key of requiredKeys) byKeyMap.set(key, {});
  for (const row of rows.byKey) {
    const bucket = byKeyMap.get(row.key);
    if (bucket) bucket[row.currency] = row.untagged;
  }

  return {
    from,
    to,
    requiredKeys,
    currencies: [...new Set(rows.totals.map((r) => r.currency))].sort(),
    totals,
    untaggedTotals,
    byKey: [...byKeyMap.entries()].map(([key, untagged]) => ({ key, untagged })),
    topUntagged: rows.topUntagged.map((row) => ({
      accountId: row.accountId,
      accountLabel: accountNames.get(row.accountId) ?? row.accountId,
      service: row.service,
      currency: row.currency,
      amount: row.amount,
    })),
  };
}

/**
 * Per-account tag compliance over the org's live resources. A resource is
 * evaluated when its stored record (fields + cached outputs) exposes a tag
 * map under the generic `tags`/`labels` convention; the score is the share of
 * evaluated resources satisfying every required tag. Resources whose types
 * expose no tags don't drag the score — they're reported in `totalResources`
 * so the gap is visible, not hidden.
 */
export async function getAccountTagCompliance(
  organizationId: string,
): Promise<AccountTagCompliance[]> {
  const policy = await getOrgTagPolicy(organizationId);

  const accountRows = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      displayName: accounts.displayName,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));

  const resourceRows = await db
    .select({
      accountId: resources.accountId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)));

  const byAccount = new Map<string, { total: number; evaluated: number; compliant: number }>();
  for (const row of resourceRows) {
    let bucket = byAccount.get(row.accountId);
    if (!bucket) {
      bucket = { total: 0, evaluated: 0, compliant: 0 };
      byAccount.set(row.accountId, bucket);
    }
    bucket.total += 1;
    // Outputs first so an explicit fields-level tag map wins the merge.
    const tags = extractRecordTags({ ...row.outputsJson, ...row.fieldsJson });
    if (tags === null) continue;
    bucket.evaluated += 1;
    if (tagPolicyViolations(tags, policy.requiredTags).length === 0) bucket.compliant += 1;
  }

  return accountRows.map((account) => {
    const bucket = byAccount.get(account.id) ?? { total: 0, evaluated: 0, compliant: 0 };
    return {
      accountId: account.id,
      pluginId: account.pluginId,
      displayName: account.displayName,
      totalResources: bucket.total,
      evaluated: bucket.evaluated,
      compliant: bucket.compliant,
      score: complianceScore(bucket.compliant, bucket.evaluated),
    };
  });
}
