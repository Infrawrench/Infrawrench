/**
 * git-feature-flag: Git is on for an organisation only once a platform admin
 * turns it on in `/admin`. Temporary. Every line that reads the flag carries
 * the marker `git-feature-flag`, so `grep -rn git-feature-flag` lists what to
 * delete; KNOWLEDGE.md "Git feature flag" has the steps.
 *
 * What it gates, in the app: the `/api/org/:orgId/git` routes (404),
 * "Managed by" on a resource, and `gitEnabled` on `/team/me`, which the
 * clients read to hide the sidebar entry, Settings > Git, the mobile row and
 * the command palette entry. On git.infrawrench.com: claiming a username,
 * which is signing up, is for members of an organisation that has Git
 * (`git/packages/worker/src/db/signups.ts` restates the query, since the
 * Worker cannot import this module's database client).
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { gitFeatureAccess } from "../db/git-feature-flag-schema.js";

/**
 * How long an answer is kept in this process. Short, so turning Git on or off
 * in `/admin` reaches every instance within it; long enough that a page's
 * burst of requests reads the table once.
 */
const CACHE_MS = 15_000;
const cache = new Map<string, { enabled: boolean; until: number }>();

export async function isGitEnabled(organizationId: string): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(organizationId);
  if (hit && hit.until > now) return hit.enabled;
  const [row] = await db
    .select({ organizationId: gitFeatureAccess.organizationId })
    .from(gitFeatureAccess)
    .where(eq(gitFeatureAccess.organizationId, organizationId))
    .limit(1);
  const enabled = row !== undefined;
  if (cache.size > 5_000) cache.clear();
  cache.set(organizationId, { enabled, until: now + CACHE_MS });
  return enabled;
}

/** Turn Git on or off for an organisation. Answers the new state. */
export async function setGitEnabled(
  organizationId: string,
  enabled: boolean,
  enabledBy: string | null,
): Promise<boolean> {
  if (enabled) {
    await db.insert(gitFeatureAccess).values({ organizationId, enabledBy }).onConflictDoNothing();
  } else {
    await db.delete(gitFeatureAccess).where(eq(gitFeatureAccess.organizationId, organizationId));
  }
  cache.set(organizationId, { enabled, until: Date.now() + CACHE_MS });
  return enabled;
}

/** Every organisation with Git on, for the admin list. */
export async function gitEnabledOrganizationIds(): Promise<Set<string>> {
  const rows = await db
    .select({ organizationId: gitFeatureAccess.organizationId })
    .from(gitFeatureAccess)
    .orderBy(desc(gitFeatureAccess.createdAt));
  return new Set(rows.map((row) => row.organizationId));
}

/** For tests: forget cached answers. */
export function resetGitFeatureCacheForTests(): void {
  cache.clear();
}
