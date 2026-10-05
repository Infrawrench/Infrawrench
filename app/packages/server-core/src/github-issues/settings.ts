/**
 * GitHub issue settings: the per-org document (default repository, labels,
 * assignees, cost-centre/tag routes, what to do when a finding resolves, the
 * pull-request switch and the Terraform source mapping), plus what each of the
 * org's GitHub App installations is allowed to do.
 *
 * No credential lives here. Filing runs on installation tokens minted from the
 * server's GitHub App key; the only org input that reaches GitHub is a
 * repository name and an installation id, and every installation id is
 * checked against the org's own `github_installations` rows before use: an
 * installation id is a guessable integer, and a token for a foreign one reads
 * somebody else's private repositories.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  defaultGithubIssueSettings,
  type GithubInstallationAccess,
  type GithubIssueSettings,
  type GithubIssueSettingsInput,
  type GithubPermissionLevel,
  type GithubResolveAction,
  validateGithubIssueSettings,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { githubInstallations, githubIssueSettings } from "../db/schema.js";
import { getInstallationAccess, isGithubAppConfigured } from "../github/app.js";
import { isRepoFullName } from "../github/issues-api.js";

export class GithubIssueSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubIssueSettingsError";
  }
}

function toRecord(row: typeof githubIssueSettings.$inferSelect): GithubIssueSettings {
  return {
    enabled: row.enabled,
    defaultRepo: row.defaultRepo ?? null,
    labels: row.labels ?? [],
    assignees: row.assignees ?? [],
    routes: row.routes ?? [],
    resolveAction: (row.resolveAction as GithubResolveAction) ?? "comment",
    pullRequestsEnabled: row.pullRequestsEnabled,
    iacSources: row.iacSources ?? [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The org's settings, or the shipped defaults when it never saved any. */
export async function getGithubIssueSettings(organizationId: string): Promise<GithubIssueSettings> {
  const [row] = await db
    .select()
    .from(githubIssueSettings)
    .where(eq(githubIssueSettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultGithubIssueSettings();
}

/** Installation ids connected (and not disconnected) to the org. */
export async function orgInstallationIds(organizationId: string): Promise<Set<number>> {
  const rows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        isNull(githubInstallations.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.installationId));
}

function cleanList(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

/**
 * Validate and store the whole document. Route and source ids are kept when
 * supplied and minted otherwise, so an editor round-trip does not churn them
 * (the Terraform provider diffs on them).
 */
export async function setGithubIssueSettings(
  organizationId: string,
  input: GithubIssueSettingsInput,
  userId: string | null,
): Promise<GithubIssueSettings> {
  const problem = validateGithubIssueSettings(input);
  if (problem) throw new GithubIssueSettingsError(problem);

  const installs = await orgInstallationIds(organizationId);
  const repos = [
    ...(input.defaultRepo ? [input.defaultRepo] : []),
    ...input.routes.map((r) => r.repo),
    ...input.iacSources.map((s) => s.repo),
  ];
  for (const repo of repos) {
    if (!installs.has(repo.installationId)) {
      throw new GithubIssueSettingsError(
        "That GitHub installation is not connected to this organization",
      );
    }
    if (!isRepoFullName(repo.fullName)) {
      throw new GithubIssueSettingsError(`"${repo.fullName}" is not a repository name`);
    }
  }

  const now = new Date();
  const values = {
    enabled: input.enabled,
    defaultRepo: input.defaultRepo ?? null,
    labels: cleanList(input.labels),
    assignees: cleanList(input.assignees),
    routes: input.routes.map((r) => ({
      id: r.id ?? randomUUID(),
      match:
        r.match.kind === "tag"
          ? {
              kind: "tag" as const,
              tagKey: r.match.tagKey.trim(),
              tagValue: r.match.tagValue?.trim() ? r.match.tagValue.trim() : null,
            }
          : { kind: "cost_centre" as const, costCentreId: r.match.costCentreId },
      repo: r.repo,
      labels: cleanList(r.labels),
      assignees: cleanList(r.assignees),
    })),
    resolveAction: input.resolveAction,
    pullRequestsEnabled: input.pullRequestsEnabled,
    iacSources: input.iacSources.map((s) => ({
      id: s.id ?? randomUUID(),
      iacAccountId: s.iacAccountId ?? null,
      repo: s.repo,
      baseBranch: s.baseBranch?.trim() ? s.baseBranch.trim() : null,
      directory: s.directory.trim().replace(/^\/+|\/+$/g, ""),
    })),
    updatedAt: now,
  };

  const [row] = await db
    .insert(githubIssueSettings)
    .values({ organizationId, createdByUserId: userId, ...values })
    .onConflictDoUpdate({ target: githubIssueSettings.organizationId, set: values })
    .returning();
  if (!row) throw new GithubIssueSettingsError("Failed to save GitHub issue settings");
  return toRecord(row);
}

function level(value: string | undefined): GithubPermissionLevel {
  return value === "write" || value === "read" || value === "admin" ? value : "none";
}

/**
 * Each connected installation with the permissions it has *accepted*. An
 * installation that has not approved the app's newer permission request
 * reads as `issues: "none"` here, which is what the settings section shows as
 * "needs approval". Read failures degrade to `checked: false`, never throw:
 * this backs a settings page and the button state on every findings list.
 */
export async function listInstallationAccess(
  organizationId: string,
): Promise<GithubInstallationAccess[]> {
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
  if (!isGithubAppConfigured()) {
    return rows.map((r) => ({
      installationId: r.installationId,
      accountLogin: r.accountLogin,
      issues: "none",
      pullRequests: "none",
      contents: "none",
      suspended: false,
      manageUrl: null,
      checked: false,
    }));
  }
  return Promise.all(
    rows.map(async (r): Promise<GithubInstallationAccess> => {
      const access = await getInstallationAccess(r.installationId).catch(() => null);
      return {
        installationId: r.installationId,
        accountLogin: access?.accountLogin ?? r.accountLogin,
        issues: level(access?.permissions["issues"]),
        pullRequests: level(access?.permissions["pull_requests"]),
        contents: level(access?.permissions["contents"]),
        suspended: access?.suspended ?? false,
        manageUrl: access?.htmlUrl ?? null,
        checked: access !== null,
      };
    }),
  );
}
