/**
 * The caches the runners keep per repository (`cache:` and `task-cache:`
 * entries, under `caches/<owner>/<repo-id>/` in their shared store), read and
 * cleared through the CI proxy. As with secrets, the owner key comes from the
 * organization's own `ci_accounts` row, so an organization can only see or
 * clear the accounts it runs CI for.
 */
import { and, eq } from "drizzle-orm";
import type { CiAccountCaches, CiCacheCleared, CiCaches } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { ciAccounts } from "../db/schema.js";
import { accountOwnerKey } from "./events.js";
import { CiProxyError, proxyJson } from "./proxy.js";
import { CiInputError } from "./runs.js";

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `GET /v1/storage/{owner}` as the runner answers it (the parts read here). */
interface RunnerStorage {
  used_bytes?: number;
  quota_bytes?: number | null;
  repos?: Record<string, { bytes?: number; entries?: number }>;
}

/** `DELETE /v1/storage/{owner}/{repo-id}` as the runner answers it. */
interface RunnerCleared {
  deleted_bytes?: number;
  deleted_entries?: number;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0);

/** Every account the organization runs CI for, with its caches per repository. */
export async function listCiCaches(organizationId: string): Promise<CiCaches> {
  const accounts = await db
    .select({ installationId: ciAccounts.installationId, accountLogin: ciAccounts.accountLogin })
    .from(ciAccounts)
    .where(eq(ciAccounts.organizationId, organizationId))
    .orderBy(ciAccounts.accountLogin);
  const out = await Promise.all(
    accounts.map(async (account): Promise<CiAccountCaches> => {
      const base = {
        installationId: account.installationId,
        accountLogin: account.accountLogin,
      };
      try {
        const usage = await proxyJson<RunnerStorage>(
          `/v1/storage/${encodeURIComponent(accountOwnerKey(account.accountLogin))}`,
        );
        const repos = Object.entries(usage.repos ?? {})
          .map(([repo, r]) => ({ repo, bytes: count(r.bytes), entries: count(r.entries) }))
          .sort((a, b) => b.bytes - a.bytes || a.repo.localeCompare(b.repo));
        return {
          ...base,
          usedBytes: count(usage.used_bytes),
          quotaBytes: typeof usage.quota_bytes === "number" ? usage.quota_bytes : null,
          repos,
          error: null,
        };
      } catch (err) {
        // One account the runners cannot answer for does not hide the others.
        return {
          ...base,
          usedBytes: 0,
          quotaBytes: null,
          repos: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return { accounts: out };
}

/**
 * Deletes one repository's caches: every branch's and pull request's
 * `cache:` and `task-cache:` entries. The next run of each job starts cold
 * and saves again. Runner-wide caches (git objects, installs) stay.
 */
export async function clearCiCache(
  organizationId: string,
  installationId: number,
  repo: string,
): Promise<CiCacheCleared> {
  if (!REPO_NAME.test(repo) || repo.includes("..")) {
    throw new CiInputError("That is not a repository name.", 400);
  }
  const [account] = await db
    .select({ accountLogin: ciAccounts.accountLogin })
    .from(ciAccounts)
    .where(
      and(
        eq(ciAccounts.organizationId, organizationId),
        eq(ciAccounts.installationId, installationId),
      ),
    )
    .limit(1);
  if (!account) {
    throw new CiInputError("That GitHub account does not run CI for this organization.", 404);
  }
  // The runner's repository id is the lowercased name (`events.ts` `repoKey`).
  const repoKey = repo.toLowerCase();
  try {
    const cleared = await proxyJson<RunnerCleared>(
      `/v1/storage/${encodeURIComponent(accountOwnerKey(account.accountLogin))}/${encodeURIComponent(repoKey)}`,
      { method: "DELETE" },
    );
    return {
      installationId,
      repo: repoKey,
      deletedEntries: count(cleared.deleted_entries),
      deletedBytes: count(cleared.deleted_bytes),
    };
  } catch (err) {
    if (!(err instanceof CiProxyError)) throw err;
    if (err.status === 400) throw new CiInputError(err.message, 400);
    // A proxy or runner that predates the route answers 404 for it.
    if (err.status === 404) throw new CiInputError("The CI runners cannot clear caches yet.", 409);
    throw new CiInputError(`The CI runners could not clear the cache: ${err.message}`, 409);
  }
}
