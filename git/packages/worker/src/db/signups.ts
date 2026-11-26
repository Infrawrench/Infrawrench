/**
 * git-feature-flag: who may sign up (claim a username) on git.infrawrench.com
 * while sign-ups are behind the app's Git flag. Temporary; KNOWLEDGE.md "Git
 * feature flag" has the removal steps, and this file goes with them.
 *
 * A person may sign up when they belong to an Infrawrench organisation that a
 * platform admin turned Git on for in the app's `/admin`
 * (`git_feature_access`). The app's own reading of the flag is server-core's
 * `git/feature-flag.ts`; this restates the one query, because the Worker
 * cannot import that module's database client.
 */
import { and, eq, exists } from "drizzle-orm";
import { gitFeatureAccess, organizationMembers } from "@infrawrench/server-core/db/schema";
import { db } from "./client";

export const maySignUp = async (userId: string): Promise<boolean> => {
  const [row] = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        exists(
          db
            .select({ id: gitFeatureAccess.organizationId })
            .from(gitFeatureAccess)
            .where(eq(gitFeatureAccess.organizationId, organizationMembers.organizationId)),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
};
