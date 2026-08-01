/**
 * Read/write side of `org_tag_policies` — the org's required-tag policy. A
 * missing row reads as the shipped defaults (no required tags, no
 * enforcement), the same protocol as `org_cost_anomaly_settings`.
 *
 * Validation lives at the API edge (`tagPolicySchema` in
 * `@infrawrench/ui/cost/config`); this module normalizes as a last line of
 * defence so a hand-written row still reads as a well-formed policy.
 */
import { eq } from "drizzle-orm";
import {
  DEFAULT_TAG_POLICY,
  TAG_POLICY_LIMITS,
  type RequiredTag,
  type TagPolicy,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgTagPolicies } from "../db/schema";

export type { RequiredTag, TagPolicy };
export { DEFAULT_TAG_POLICY, TAG_POLICY_LIMITS };

/** Force a stored (or hand-written) policy back inside the documented bounds. */
export function normalizeTagPolicy(input: TagPolicy): TagPolicy {
  const seen = new Set<string>();
  const requiredTags: RequiredTag[] = [];
  for (const raw of Array.isArray(input.requiredTags) ? input.requiredTags : []) {
    if (requiredTags.length >= TAG_POLICY_LIMITS.maxRequiredTags) break;
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    if (!key || key.length > TAG_POLICY_LIMITS.maxKeyLength) continue;
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const allowedValues = Array.isArray(raw.allowedValues)
      ? raw.allowedValues
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0 && v.length <= TAG_POLICY_LIMITS.maxValueLength)
          .slice(0, TAG_POLICY_LIMITS.maxAllowedValues)
      : [];
    requiredTags.push(allowedValues.length > 0 ? { key, allowedValues } : { key });
  }
  return { requiredTags, enforceOnCreate: input.enforceOnCreate === true };
}

/** The org's tag policy; a missing row reads as the shipped defaults. */
export async function getOrgTagPolicy(organizationId: string): Promise<TagPolicy> {
  const [row] = await db
    .select()
    .from(orgTagPolicies)
    .where(eq(orgTagPolicies.organizationId, organizationId));
  if (!row) return { ...DEFAULT_TAG_POLICY, requiredTags: [] };
  return normalizeTagPolicy({
    requiredTags: row.requiredTags,
    enforceOnCreate: row.enforceOnCreate,
  });
}

/** Save the org's tag policy, creating the row on first use. */
export async function setOrgTagPolicy(
  organizationId: string,
  policy: TagPolicy,
  now = new Date(),
): Promise<TagPolicy> {
  const safe = normalizeTagPolicy(policy);
  const [row] = await db
    .insert(orgTagPolicies)
    .values({ organizationId, ...safe })
    .onConflictDoUpdate({
      target: orgTagPolicies.organizationId,
      set: { ...safe, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save tag policy");
  return normalizeTagPolicy({
    requiredTags: row.requiredTags,
    enforceOnCreate: row.enforceOnCreate,
  });
}
