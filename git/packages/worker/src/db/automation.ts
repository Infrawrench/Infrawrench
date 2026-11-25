/**
 * What runs on a repository's commits, as rows: Infrawrench CI's runs (the
 * app's own tables, read here and written by the app) and Terraform
 * workspaces, runs, state versions and managed resources.
 */
import { type SQL, and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  type GitTerraformRunStatus,
  accounts,
  ciGitRepositories,
  ciRuns,
  ciSchedules,
  gitTerraformManagedResources,
  gitTerraformRuns,
  gitTerraformStateVersions,
  gitTerraformWorkspaceAccounts,
  gitTerraformWorkspaces,
  resources,
} from "@infrawrench/server-core/db/schema";
import { db, isUniqueViolation, newId } from "./client";
import { type PageOf, afterCursor, cursorTime, decodeCursor, pageSize, toPage } from "./cursor";

export type CiRunRow = typeof ciRuns.$inferSelect;
export type WorkspaceRow = typeof gitTerraformWorkspaces.$inferSelect;
export type TerraformRunRow = typeof gitTerraformRuns.$inferSelect;
export type StateVersionRow = typeof gitTerraformStateVersions.$inferSelect;

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

export interface ListCiRunsOptions {
  readonly sha?: string | undefined;
  readonly ref?: string | undefined;
  readonly pull?: number | undefined;
  readonly status?: CiRunRow["status"] | undefined;
  readonly event?: CiRunRow["event"] | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** A repository's CI runs, newest first. `skipped` ones only when asked for by status. */
export const listCiRuns = async (
  repositoryId: string,
  options: ListCiRunsOptions,
): Promise<PageOf<CiRunRow>> => {
  const limit = pageSize(options.limit);
  const rows = await db
    .select()
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.gitRepositoryId, repositoryId),
        options.status ? eq(ciRuns.status, options.status) : notInArray(ciRuns.status, ["skipped"]),
        options.sha ? eq(ciRuns.sha, options.sha.toLowerCase()) : undefined,
        options.ref ? eq(ciRuns.headRef, options.ref) : undefined,
        options.pull !== undefined ? eq(ciRuns.pullNumber, options.pull) : undefined,
        options.event ? eq(ciRuns.event, options.event) : undefined,
        afterCursor(ciRuns.createdAt, ciRuns.id, decodeCursor(options.cursor), "desc"),
      ),
    )
    .orderBy(desc(cursorTime(ciRuns.createdAt)), desc(ciRuns.id))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({ at: row.createdAt.getTime(), id: row.id }));
};

/** A run, only if it is this repository's. */
export const getCiRun = async (repositoryId: string, runId: string): Promise<CiRunRow | null> => {
  const [row] = await db
    .select()
    .from(ciRuns)
    .where(and(eq(ciRuns.id, runId), eq(ciRuns.gitRepositoryId, repositoryId)))
    .limit(1);
  return row ?? null;
};

/** The runs that retried these, newest winning, by the run they retried. */
export const ciRetriesOf = async (runIds: readonly string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({ id: ciRuns.id, retryOfRunId: ciRuns.retryOfRunId })
    .from(ciRuns)
    .where(inArray(ciRuns.retryOfRunId, [...runIds]))
    .orderBy(asc(ciRuns.createdAt));
  for (const row of rows) if (row.retryOfRunId) out.set(row.retryOfRunId, row.id);
  return out;
};

/** The repository's CI switch: no row means on. */
export const ciSwitchedOff = async (repositoryId: string): Promise<boolean> => {
  const [row] = await db
    .select({ ciEnabled: ciGitRepositories.ciEnabled })
    .from(ciGitRepositories)
    .where(eq(ciGitRepositories.gitRepositoryId, repositoryId))
    .limit(1);
  return row?.ciEnabled === false;
};

/** The pipelines CI last read from the default branch, when it has read any. */
export const ciKnownPipelines = async (
  repositoryId: string,
): Promise<Array<{ file: string; name: string }>> => {
  const [row] = await db
    .select({ pipelines: ciSchedules.pipelines, manual: ciSchedules.manual })
    .from(ciSchedules)
    .where(eq(ciSchedules.gitRepositoryId, repositoryId))
    .limit(1);
  const found = new Map<string, string>();
  for (const entry of [...(row?.pipelines ?? []), ...(row?.manual ?? [])]) {
    found.set(entry.file, entry.name);
  }
  return [...found].map(([file, name]) => ({ file, name }));
};

// ---------------------------------------------------------------------------
// Terraform
// ---------------------------------------------------------------------------

export const listWorkspaces = (repositoryId: string): Promise<WorkspaceRow[]> =>
  db
    .select()
    .from(gitTerraformWorkspaces)
    .where(eq(gitTerraformWorkspaces.repositoryId, repositoryId))
    .orderBy(asc(gitTerraformWorkspaces.name));

export const getWorkspace = async (
  repositoryId: string,
  name: string,
): Promise<WorkspaceRow | null> => {
  const [row] = await db
    .select()
    .from(gitTerraformWorkspaces)
    .where(
      and(
        eq(gitTerraformWorkspaces.repositoryId, repositoryId),
        eq(gitTerraformWorkspaces.name, name),
      ),
    )
    .limit(1);
  return row ?? null;
};

export type WorkspaceSettings = Partial<
  Pick<
    WorkspaceRow,
    "name" | "branch" | "toolVersion" | "planOnPullRequest" | "applyOnMerge" | "autoApply"
  >
>;

/** Replace a workspace's connected accounts. */
const setWorkspaceAccounts = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  accountIds: readonly string[],
  addedByUserId: string | null,
): Promise<void> => {
  await tx
    .delete(gitTerraformWorkspaceAccounts)
    .where(eq(gitTerraformWorkspaceAccounts.workspaceId, workspaceId));
  if (accountIds.length > 0) {
    await tx
      .insert(gitTerraformWorkspaceAccounts)
      .values(
        [...new Set(accountIds)].map((accountId) => ({ workspaceId, accountId, addedByUserId })),
      );
  }
};

/** Create a workspace. Null when the repository has one of that name. */
export const createWorkspace = async (workspace: {
  readonly repositoryId: string;
  readonly organizationId: string | null;
  readonly name: string;
  readonly rootPath: string;
  readonly settings: WorkspaceSettings;
  readonly accountIds: readonly string[];
  readonly createdByUserId: string | null;
}): Promise<WorkspaceRow | null> => {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(gitTerraformWorkspaces)
        .values({
          id: newId(),
          repositoryId: workspace.repositoryId,
          organizationId: workspace.organizationId,
          rootPath: workspace.rootPath,
          createdByUserId: workspace.createdByUserId,
          ...workspace.settings,
          name: workspace.name,
        })
        .returning();
      await setWorkspaceAccounts(tx, row!.id, workspace.accountIds, workspace.createdByUserId);
      return row!;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

/** Change a workspace. Null when its new name is another workspace's. */
export const updateWorkspace = async (
  workspaceId: string,
  settings: WorkspaceSettings,
  accountIds: readonly string[] | undefined,
  byUserId: string | null,
): Promise<WorkspaceRow | null> => {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(gitTerraformWorkspaces)
        .set({ ...settings, updatedAt: new Date() })
        .where(eq(gitTerraformWorkspaces.id, workspaceId))
        .returning();
      if (row && accountIds !== undefined) {
        await setWorkspaceAccounts(tx, workspaceId, accountIds, byUserId);
      }
      return row ?? null;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

/** Delete a workspace, unless something holds its lock. False when it is locked. */
export const deleteWorkspace = async (workspaceId: string): Promise<boolean> => {
  const deleted = await db
    .delete(gitTerraformWorkspaces)
    .where(and(eq(gitTerraformWorkspaces.id, workspaceId), isNull(gitTerraformWorkspaces.lockId)))
    .returning({ id: gitTerraformWorkspaces.id });
  return deleted.length > 0;
};

export const clearWorkspaceLock = async (workspaceId: string): Promise<void> => {
  await db
    .update(gitTerraformWorkspaces)
    .set({ lockId: null, lockInfo: null, lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(eq(gitTerraformWorkspaces.id, workspaceId));
};

/** The accounts of these workspaces, by workspace id. */
export const workspaceAccounts = async (
  workspaceIds: readonly string[],
): Promise<Map<string, Array<{ accountId: string; name: string; pluginId: string }>>> => {
  const out = new Map<string, Array<{ accountId: string; name: string; pluginId: string }>>();
  if (workspaceIds.length === 0) return out;
  const rows = await db
    .select({
      workspaceId: gitTerraformWorkspaceAccounts.workspaceId,
      accountId: accounts.id,
      name: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(gitTerraformWorkspaceAccounts)
    .innerJoin(accounts, eq(accounts.id, gitTerraformWorkspaceAccounts.accountId))
    .where(inArray(gitTerraformWorkspaceAccounts.workspaceId, [...workspaceIds]))
    .orderBy(asc(accounts.displayName));
  for (const { workspaceId, ...account } of rows) {
    out.set(workspaceId, [...(out.get(workspaceId) ?? []), account]);
  }
  return out;
};

/** Which of these accounts belong to the organisation. */
export const accountsOfOrganization = async (
  organizationId: string,
  accountIds: readonly string[],
): Promise<Set<string>> => {
  if (accountIds.length === 0) return new Set();
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, [...accountIds])));
  return new Set(rows.map((row) => row.id));
};

export const stateVersionsById = async (
  ids: readonly string[],
): Promise<Map<string, StateVersionRow>> => {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(gitTerraformStateVersions)
    .where(inArray(gitTerraformStateVersions.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
};

export const listStateVersions = async (
  workspaceId: string,
  options: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
): Promise<PageOf<StateVersionRow>> => {
  const limit = pageSize(options.limit);
  const rows = await db
    .select()
    .from(gitTerraformStateVersions)
    .where(
      and(
        eq(gitTerraformStateVersions.workspaceId, workspaceId),
        afterCursor(
          gitTerraformStateVersions.createdAt,
          gitTerraformStateVersions.id,
          decodeCursor(options.cursor),
          "desc",
        ),
      ),
    )
    .orderBy(
      desc(cursorTime(gitTerraformStateVersions.createdAt)),
      desc(gitTerraformStateVersions.id),
    )
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({ at: row.createdAt.getTime(), id: row.id }));
};

export interface ListTerraformRunsOptions {
  readonly workspaceId?: string | undefined;
  readonly pull?: number | undefined;
  readonly statuses?: readonly GitTerraformRunStatus[] | undefined;
  readonly kind?: "plan" | "apply" | undefined;
  /** Only runs whose plan found changes (true) or none (false). */
  readonly hasChanges?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const listTerraformRuns = async (
  repositoryId: string,
  options: ListTerraformRunsOptions,
): Promise<PageOf<TerraformRunRow>> => {
  const limit = pageSize(options.limit);
  const hasChanges = sql`coalesce((${gitTerraformRuns.planSummary}->>'hasChanges')::boolean, true)`;
  const filters: (SQL | undefined)[] = [
    eq(gitTerraformRuns.repositoryId, repositoryId),
    options.workspaceId ? eq(gitTerraformRuns.workspaceId, options.workspaceId) : undefined,
    options.pull !== undefined ? eq(gitTerraformRuns.pullNumber, options.pull) : undefined,
    options.statuses ? inArray(gitTerraformRuns.status, [...options.statuses]) : undefined,
    options.kind ? eq(gitTerraformRuns.kind, options.kind) : undefined,
    options.hasChanges === undefined ? undefined : sql`${hasChanges} = ${options.hasChanges}`,
    afterCursor(
      gitTerraformRuns.createdAt,
      gitTerraformRuns.id,
      decodeCursor(options.cursor),
      "desc",
    ),
  ];
  const rows = await db
    .select()
    .from(gitTerraformRuns)
    .where(and(...filters))
    .orderBy(desc(cursorTime(gitTerraformRuns.createdAt)), desc(gitTerraformRuns.id))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({ at: row.createdAt.getTime(), id: row.id }));
};

export const getTerraformRun = async (
  repositoryId: string,
  runId: string,
): Promise<TerraformRunRow | null> => {
  const [row] = await db
    .select()
    .from(gitTerraformRuns)
    .where(and(eq(gitTerraformRuns.id, runId), eq(gitTerraformRuns.repositoryId, repositoryId)))
    .limit(1);
  return row ?? null;
};

/** The newest run of each of these workspaces, by workspace id. */
export const lastRunsOf = async (
  workspaceIds: readonly string[],
): Promise<Map<string, TerraformRunRow>> => {
  const out = new Map<string, TerraformRunRow>();
  if (workspaceIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([gitTerraformRuns.workspaceId])
    .from(gitTerraformRuns)
    .where(inArray(gitTerraformRuns.workspaceId, [...workspaceIds]))
    .orderBy(gitTerraformRuns.workspaceId, desc(gitTerraformRuns.createdAt));
  for (const row of rows) out.set(row.workspaceId, row);
  return out;
};

/**
 * Move a run from one of `from` to `to`. Null when it was not in one of
 * them any more: two people deciding at once make one change.
 */
export const moveTerraformRun = async (
  runId: string,
  from: readonly GitTerraformRunStatus[],
  to: GitTerraformRunStatus,
  extra: Partial<Pick<TerraformRunRow, "approvedByUserId" | "approvedAt" | "finishedAt">> = {},
): Promise<TerraformRunRow | null> => {
  const [row] = await db
    .update(gitTerraformRuns)
    .set({ status: to, ...extra })
    .where(and(eq(gitTerraformRuns.id, runId), inArray(gitTerraformRuns.status, [...from])))
    .returning();
  return row ?? null;
};

export interface ManagedResourceRow {
  readonly resource: typeof gitTerraformManagedResources.$inferSelect;
  readonly matched: {
    readonly id: string;
    readonly displayName: string;
    readonly pluginId: string;
    readonly resourceTypeId: string;
  } | null;
}

/** The resources a workspace manages, by address. The cursor is the last address. */
export const listManagedResources = async (
  workspaceId: string,
  options: {
    readonly q?: string | undefined;
    readonly matched?: boolean | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
): Promise<PageOf<ManagedResourceRow>> => {
  const limit = pageSize(options.limit);
  const q = options.q?.trim().toLowerCase();
  const pattern = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await db
    .select({
      resource: gitTerraformManagedResources,
      matched: {
        id: resources.id,
        displayName: resources.displayName,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
      },
    })
    .from(gitTerraformManagedResources)
    .leftJoin(
      resources,
      and(
        eq(resources.id, gitTerraformManagedResources.resourceId),
        eq(resources.organizationId, gitTerraformManagedResources.organizationId),
      ),
    )
    .where(
      and(
        eq(gitTerraformManagedResources.workspaceId, workspaceId),
        pattern
          ? sql`(lower(${gitTerraformManagedResources.address}) like ${pattern} or lower(${gitTerraformManagedResources.terraformType}) like ${pattern})`
          : undefined,
        options.matched === undefined
          ? undefined
          : options.matched
            ? sql`${resources.id} is not null`
            : sql`${resources.id} is null`,
        options.cursor
          ? sql`${gitTerraformManagedResources.address} > ${options.cursor}`
          : undefined,
      ),
    )
    .orderBy(asc(gitTerraformManagedResources.address))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((row) => ({
      resource: row.resource,
      matched: row.matched?.id ? row.matched : null,
    })),
    nextCursor: rows.length > limit && last ? last.resource.address : null,
  };
};
