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
 *
 * An organisation claims its namespace here only while it has Git on too
 * ({@link gitEnabledAmong}), as the app's Settings > Git does. One that already
 * has a namespace is never asked: turning Git off locks nobody out of code.
 */
import { and, eq, exists, inArray } from "drizzle-orm";
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

/** Which of these organisations have Git turned on. */
export const gitEnabledAmong = async (
  organizationIds: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  if (organizationIds.length === 0) return new Set();
  const rows = await db
    .select({ organizationId: gitFeatureAccess.organizationId })
    .from(gitFeatureAccess)
    .where(inArray(gitFeatureAccess.organizationId, [...organizationIds]));
  return new Set(rows.map((row) => row.organizationId));
};
