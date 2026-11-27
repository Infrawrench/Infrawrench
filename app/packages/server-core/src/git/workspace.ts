/**
 * The organisation a person's own namespace on git.infrawrench.com runs in.
 *
 * An organisation's namespace runs CI and review agents as that
 * organisation. A person's own namespace has none, so it runs nothing until
 * its owner connects it to one they belong to
 * (`git_namespaces.workspace_organization_id`); from then on its
 * repositories run CI and review agents there and are billed there.
 *
 * - **The link counts only while the person is a member.** Every read here
 *   goes through `organization_members`, so someone who leaves (or is
 *   removed from) the organisation stops spending its money with nothing
 *   written. The stale column is cleared, with the CI rows it left, by
 *   {@link sweepGitWorkspaces} from the poller, and by the forge when the
 *   person next loads their session.
 * - **Only the namespace's owner sets it**, and only to an organisation they
 *   belong to: {@link setGitWorkspace} checks both in the statement that
 *   writes.
 * - **A connected repository is not one of the organisation's.** It is
 *   `personal` to CI (`ci/source.ts` `grantCoversRepo`): something the
 *   organisation lends to "every repository" is not lent to it, since its
 *   owner alone decides what its branches hold.
 *
 * Postgres only, and imported by the forge's Worker: nothing here may reach
 * plugin code or a socket driver.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { ciGitRepositories, ciSchedules, gitNamespaces, gitRepositories } from "../db/schema.js";

/**
 * A namespace's connected organisation while its owner is still a member of
 * it, else null. For any query that reads `git_namespaces` under its own
 * name. Written out rather than built from columns: in a query of one table
 * the columns would be spelled without their tables, and the two
 * `organization_id`s would be compared with themselves.
 */
export const liveGitWorkspaceId = sql<string | null>`(
  select om.organization_id from organization_members om
  where om.organization_id = git_namespaces.workspace_organization_id
    and om.user_id = git_namespaces.user_id
  limit 1
)`;

/** Where a repository of the forge runs CI and review agents. */
export interface GitCiHome {
  /** The organisation that is billed and whose plan decides. */
  organizationId: string;
  /** A person's own repository, connected to the organisation, not one of its own. */
  personal: boolean;
}

/**
 * The organisation a repository runs in now: its namespace's, or for a
 * person's namespace the one it is connected to. Null when there is none
 * (not connected, the person has left, or no such repository).
 */
export async function gitCiHome(gitRepositoryId: string): Promise<GitCiHome | null> {
  const [row] = await db
    .select({
      kind: gitNamespaces.kind,
      organizationId: gitNamespaces.organizationId,
      workspace: liveGitWorkspaceId,
    })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(eq(gitRepositories.id, gitRepositoryId))
    .limit(1);
  if (!row) return null;
  if (row.kind === "org") {
    return row.organizationId ? { organizationId: row.organizationId, personal: false } : null;
  }
  return row.workspace ? { organizationId: row.workspace, personal: true } : null;
}

/** A person's connected organisation, or null. Reads through their membership. */
export async function gitWorkspaceOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspace: liveGitWorkspaceId })
    .from(gitNamespaces)
    .where(eq(gitNamespaces.userId, userId))
    .limit(1);
  return row?.workspace ?? null;
}

/**
 * Forgets what CI kept for a person's repositories under an organisation
 * they no longer run in: the switch rows that list them in its CI tab and
 * let it set their secrets, and the schedules that would fire as its runs.
 * Runs already recorded stay, as its history.
 */
async function forgetCiFor(namespaceId: string, exceptOrganizationId: string | null) {
  const repositories = db
    .select({ id: gitRepositories.id })
    .from(gitRepositories)
    .where(eq(gitRepositories.namespaceId, namespaceId));
  const other = exceptOrganizationId
    ? sql`${ciGitRepositories.organizationId} <> ${exceptOrganizationId}`
    : sql`true`;
  await db
    .delete(ciGitRepositories)
    .where(and(inArray(ciGitRepositories.gitRepositoryId, repositories), other));
  const otherSchedule = exceptOrganizationId
    ? sql`${ciSchedules.organizationId} <> ${exceptOrganizationId}`
    : sql`true`;
  await db
    .delete(ciSchedules)
    .where(and(inArray(ciSchedules.gitRepositoryId, repositories), otherSchedule));
}

export type SetGitWorkspaceResult =
  | { ok: true; organizationId: string | null }
  /** `no_namespace`: the person has no username yet. `not_member`: not their organisation. */
  | { ok: false; reason: "no_namespace" | "not_member" };

/**
 * Connects a person's own namespace to an organisation they belong to, or
 * to none. The membership is checked by the update itself, so a race with
 * their removal cannot connect them.
 */
export async function setGitWorkspace(
  userId: string,
  organizationId: string | null,
): Promise<SetGitWorkspaceResult> {
  const now = new Date();
  const mine = and(eq(gitNamespaces.userId, userId), eq(gitNamespaces.kind, "user"));
  const [row] =
    organizationId === null
      ? await db
          .update(gitNamespaces)
          .set({ workspaceOrganizationId: null, updatedAt: now })
          .where(mine)
          .returning({ id: gitNamespaces.id })
      : await db
          .update(gitNamespaces)
          .set({ workspaceOrganizationId: organizationId, updatedAt: now })
          .where(
            and(
              mine,
              sql`exists (select 1 from organization_members om where om.organization_id = ${organizationId} and om.user_id = ${userId})`,
            ),
          )
          .returning({ id: gitNamespaces.id });
  if (!row) {
    const [namespace] = await db
      .select({ id: gitNamespaces.id })
      .from(gitNamespaces)
      .where(mine)
      .limit(1);
    return { ok: false, reason: namespace ? "not_member" : "no_namespace" };
  }
  await forgetCiFor(row.id, organizationId);
  return { ok: true, organizationId };
}

const NOT_A_MEMBER = sql`not exists (select 1 from organization_members om where om.organization_id = git_namespaces.workspace_organization_id and om.user_id = git_namespaces.user_id)`;

/** Clears one namespace's connection if its owner has left the organisation. */
async function clearIfStale(namespaceId: string): Promise<boolean> {
  const [cleared] = await db
    .update(gitNamespaces)
    .set({ workspaceOrganizationId: null, updatedAt: new Date() })
    .where(
      and(
        eq(gitNamespaces.id, namespaceId),
        isNotNull(gitNamespaces.workspaceOrganizationId),
        NOT_A_MEMBER,
      ),
    )
    .returning({ id: gitNamespaces.id });
  if (!cleared) return false;
  await forgetCiFor(namespaceId, null);
  return true;
}

/**
 * Clears a person's connection if they have left the organisation it names.
 * The forge calls it when it finds the stored connection is not a live one.
 */
export async function clearStaleGitWorkspace(userId: string): Promise<boolean> {
  const [namespace] = await db
    .select({ id: gitNamespaces.id })
    .from(gitNamespaces)
    .where(eq(gitNamespaces.userId, userId))
    .limit(1);
  return namespace ? clearIfStale(namespace.id) : false;
}

/**
 * Clears the connections of people who are no longer members of the
 * organisation they named, and what CI kept for them. Nothing reads a stale
 * connection as a live one, so this is housekeeping: it takes their
 * repositories out of the organisation's CI tab. Returns how many were
 * cleared.
 */
export async function sweepGitWorkspaces(limit = 200): Promise<number> {
  const stale = await db
    .select({ id: gitNamespaces.id })
    .from(gitNamespaces)
    .where(and(isNotNull(gitNamespaces.workspaceOrganizationId), NOT_A_MEMBER))
    .limit(limit);
  let cleared = 0;
  for (const namespace of stale) {
    if (await clearIfStale(namespace.id)) cleared++;
  }
  return cleared;
}
