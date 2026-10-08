/**
 * Pull request check settings: one row per repository, plus what each of the
 * org's GitHub App installations has accepted of the permissions checks need.
 *
 * No credential lives here, as with GitHub issue filing: the only org input
 * that reaches GitHub is a repository name and an installation id, and the
 * installation id is checked against the org's own `github_installations`
 * rows on every write (an installation id is a guessable integer).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  normalizePrCheckDirectory,
  validatePrCheckRepositoryInput,
  PR_CHECK_LIMITS,
  type GithubPermissionLevel,
  type PrCheckInstallationAccess,
  type PrCheckRepository,
  type PrCheckRepositoryInput,
  type PrCheckThresholdConclusion,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { githubInstallations, prCheckRepositories } from "../db/schema.js";
import { getInstallationAccess, isGithubAppConfigured } from "../github/app.js";
import { isRepoFullName } from "../github/issues-api.js";
import { orgInstallationIds } from "../github-issues/settings.js";

export class PrCheckSettingsError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "PrCheckSettingsError";
    this.status = status;
  }
}

type Row = typeof prCheckRepositories.$inferSelect;

export function toPrCheckRepository(row: Row): PrCheckRepository {
  return {
    id: row.id,
    installationId: row.installationId,
    repo: row.repo,
    enabled: row.enabled,
    commentEnabled: row.commentEnabled,
    costThreshold: row.costThreshold ?? null,
    thresholdConclusion: (row.thresholdConclusion as PrCheckThresholdConclusion) ?? "neutral",
    directories: row.directories ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPrCheckRepositories(
  organizationId: string,
): Promise<PrCheckRepository[]> {
  const rows = await db
    .select()
    .from(prCheckRepositories)
    .where(eq(prCheckRepositories.organizationId, organizationId))
    .orderBy(asc(prCheckRepositories.repo));
  return rows.map(toPrCheckRepository);
}

export async function getPrCheckRepository(
  organizationId: string,
  id: string,
): Promise<PrCheckRepository | null> {
  const [row] = await db
    .select()
    .from(prCheckRepositories)
    .where(
      and(eq(prCheckRepositories.organizationId, organizationId), eq(prCheckRepositories.id, id)),
    )
    .limit(1);
  return row ? toPrCheckRepository(row) : null;
}

async function clean(
  organizationId: string,
  input: PrCheckRepositoryInput,
): Promise<PrCheckRepositoryInput> {
  const directories = [
    ...new Set(input.directories.map(normalizePrCheckDirectory).filter((d) => d.length > 0)),
  ];
  const normalized: PrCheckRepositoryInput = { ...input, repo: input.repo.trim(), directories };
  const problem = validatePrCheckRepositoryInput(normalized);
  if (problem) throw new PrCheckSettingsError(problem);
  if (!isRepoFullName(normalized.repo)) throw new PrCheckSettingsError("Pick a repository.");
  if (!(await orgInstallationIds(organizationId)).has(normalized.installationId)) {
    throw new PrCheckSettingsError(
      "That GitHub installation is not connected to this organization.",
    );
  }
  return normalized;
}

export async function createPrCheckRepository(
  organizationId: string,
  input: PrCheckRepositoryInput,
  userId: string | null,
): Promise<PrCheckRepository> {
  const value = await clean(organizationId, input);
  const existing = await db
    .select({ id: prCheckRepositories.id })
    .from(prCheckRepositories)
    .where(eq(prCheckRepositories.organizationId, organizationId));
  if (existing.length >= PR_CHECK_LIMITS.maxRepositories) {
    throw new PrCheckSettingsError(
      `At most ${PR_CHECK_LIMITS.maxRepositories} repositories can have checks.`,
    );
  }
  const now = new Date();
  const [row] = await db
    .insert(prCheckRepositories)
    .values({
      id: randomUUID(),
      organizationId,
      installationId: value.installationId,
      repo: value.repo,
      enabled: value.enabled,
      commentEnabled: value.commentEnabled,
      costThreshold: value.costThreshold,
      thresholdConclusion: value.thresholdConclusion,
      directories: value.directories,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    throw new PrCheckSettingsError(`${value.repo} already has checks configured.`, 409);
  }
  return toPrCheckRepository(row);
}

export async function updatePrCheckRepository(
  organizationId: string,
  id: string,
  input: PrCheckRepositoryInput,
): Promise<PrCheckRepository> {
  const value = await clean(organizationId, input);
  try {
    const [row] = await db
      .update(prCheckRepositories)
      .set({
        installationId: value.installationId,
        repo: value.repo,
        enabled: value.enabled,
        commentEnabled: value.commentEnabled,
        costThreshold: value.costThreshold,
        thresholdConclusion: value.thresholdConclusion,
        directories: value.directories,
        updatedAt: new Date(),
      })
      .where(
        and(eq(prCheckRepositories.organizationId, organizationId), eq(prCheckRepositories.id, id)),
      )
      .returning();
    if (!row) throw new PrCheckSettingsError("Unknown repository.", 404);
    return toPrCheckRepository(row);
  } catch (err) {
    if (err instanceof PrCheckSettingsError) throw err;
    // The unique (org, repo) index: renaming onto a repository that is
    // already configured.
    if (String((err as { code?: string }).code) === "23505") {
      throw new PrCheckSettingsError(`${value.repo} already has checks configured.`, 409);
    }
    throw err;
  }
}

export async function deletePrCheckRepository(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(prCheckRepositories)
    .where(
      and(eq(prCheckRepositories.organizationId, organizationId), eq(prCheckRepositories.id, id)),
    )
    .returning({ id: prCheckRepositories.id });
  return rows.length > 0;
}

function level(value: string | undefined): GithubPermissionLevel {
  return value === "read" || value === "write" || value === "admin" ? value : "none";
}

/**
 * Each connected installation with the permissions checks need, as
 * *accepted* by the account owner. Read failures degrade to
 * `checked: false`; this backs a settings page and must never throw.
 */
export async function listPrCheckInstallationAccess(
  organizationId: string,
): Promise<PrCheckInstallationAccess[]> {
  const rows = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        isNull(githubInstallations.deletedAt),
      ),
    );
  const configured = isGithubAppConfigured();
  return Promise.all(
    rows.map(async (r): Promise<PrCheckInstallationAccess> => {
      const access = configured
        ? await getInstallationAccess(r.installationId).catch(() => null)
        : null;
      return {
        installationId: r.installationId,
        accountLogin: access?.accountLogin ?? r.accountLogin,
        checks: level(access?.permissions["checks"]),
        pullRequests: level(access?.permissions["pull_requests"]),
        contents: level(access?.permissions["contents"]),
        suspended: access?.suspended ?? false,
        manageUrl: access?.htmlUrl ?? null,
        checked: access !== null,
      };
    }),
  );
}
