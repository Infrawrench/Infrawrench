/**
 * GitHub tokens lent to a run's jobs (`github-token:` in a pipeline, the
 * run request's `lent.github-token`; `ci-runner/README.md`, "GitHub token").
 *
 * - Minted at dispatch from the GitHub App installation the run came
 *   through, scoped to the run's own repository and to exactly the
 *   permissions the job names: GitHub's installation access token, which
 *   lasts an hour. Jobs asking for the same permissions share one token.
 * - Never for a fork's pull request: nothing is sent, and the runner fails
 *   every job that asks with its own reason.
 * - A permission the installation does not have is refused before anything
 *   is minted, naming it, and the job that asks fails with that reason
 *   before it starts.
 * - What a job gets: `GH_TOKEN` and `GITHUB_TOKEN`, `GH_REPO`, and Git's
 *   global configuration with the token as an `Authorization` header for
 *   the repository's URL, so `git push` works, and `GIT_TERMINAL_PROMPT=0`
 *   so a refused token fails Git rather than waiting for a password. Every
 *   secret part is masked by the runner. Nothing here stores the token.
 * - Every lend is audit logged against the installation.
 *
 * Calls only GitHub, so unlike `lend.ts` it runs on the edge too.
 */
import { db } from "../db/client.js";
import { isGitSource } from "./source.js";
import { auditLogs, type CiJobAccess } from "../db/schema.js";

/** A lent entry as the run request carries it (`lend.ts`'s `LentEntry`, with an expiry). */
export type GithubTokenEntry =
  | { refused: string }
  | {
      env: Record<string, string | Array<{ text: string } | { secret: string }>>;
      files: Array<{
        path: string;
        mode: string;
        content: Array<{ text: string } | { secret: string }>;
      }>;
      /** Seconds since the Unix epoch. */
      "expires-at": number;
    };

export type GithubTokenLevel = "read" | "write";

/**
 * What a job's `github-token:` may name, by GitHub Actions' names, and the
 * installation permission each is (the runner refuses any other at parse
 * time; `GITHUB_TOKEN_PERMISSIONS` in `iwci-spec`).
 */
export const GITHUB_TOKEN_PERMISSIONS: Readonly<Record<string, string>> = {
  actions: "actions",
  checks: "checks",
  contents: "contents",
  deployments: "deployments",
  discussions: "discussions",
  issues: "issues",
  packages: "packages",
  pages: "pages",
  "pull-requests": "pull_requests",
  statuses: "statuses",
};

/** Where the Git configuration goes, and `GIT_CONFIG_GLOBAL` points. */
export const GIT_CONFIG_PATH = "/root/.gitconfig";

/** The runner's limits (`lent.rs`). */
const MAX_ENTRIES = 64;
const MAX_REASON = 1024;

/**
 * The key a token is lent under, as the runner computes it for a job
 * (`JobAccess::github_token_key`): the permissions in order, `name=level`,
 * joined by commas.
 */
export function githubTokenKey(permissions: Readonly<Record<string, string>>): string {
  return Object.keys(permissions)
    .sort()
    .map((k) => `${k}=${permissions[k]}`)
    .join(",");
}

/** Each distinct set of permissions the run's jobs ask for, by its key. */
export function githubTokenRequests(
  access: readonly CiJobAccess[] | null,
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const job of access ?? []) {
    if (!job.githubToken || Object.keys(job.githubToken).length === 0) continue;
    out.set(githubTokenKey(job.githubToken), job.githubToken);
  }
  return out;
}

/** What the run is, as lending a token checks it. */
export interface TokenRun {
  id: string;
  organizationId: string;
  installationId: number;
  /** Set for a repository on git.infrawrench.com, which has no GitHub token to lend. */
  gitRepositoryId?: string | null | undefined;
  repoFullName: string;
  headRef: string;
  fromFork: boolean;
}

/** Seam for tests: how GitHub is asked. */
export interface GithubTokenDeps {
  /** The installation's granted permissions, or null when GitHub cannot say. */
  installationPermissions(installationId: number): Promise<Record<string, string> | null>;
  mint(
    installationId: number,
    repository: string,
    permissions: Record<string, GithubTokenLevel>,
  ): Promise<{ token: string; expiresAt: string }>;
}

// The App's helpers are loaded when first used, so a module that imports
// this one for its types and pure helpers does not load them.
const defaultDeps: GithubTokenDeps = {
  installationPermissions: async (id) => {
    const { getInstallationAccess } = await import("../github/app.js");
    return (await getInstallationAccess(id))?.permissions ?? null;
  },
  mint: async (id, repository, permissions) => {
    const { mintRepositoryToken } = await import("../github/app.js");
    return mintRepositoryToken(id, repository, permissions);
  },
};

function refused(text: string): { refused: string } {
  return { refused: text.slice(0, MAX_REASON) };
}

const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Why the installation cannot grant these permissions, or null when it can. */
export function missingPermissions(
  wanted: Readonly<Record<string, string>>,
  granted: Readonly<Record<string, string>>,
): string[] {
  const missing: string[] = [];
  for (const [name, level] of Object.entries(wanted)) {
    const api = GITHUB_TOKEN_PERMISSIONS[name];
    const have = api ? (LEVELS[granted[api] ?? ""] ?? 0) : 0;
    if (have < (LEVELS[level] ?? 3)) missing.push(`${name}: ${level}`);
  }
  return missing;
}

/**
 * What a job is given for a token: the variables gh and the API clients
 * read, and Git's global configuration with the token as a header for the
 * repository's two URLs (Git matches `https://github.com/acme/web` and
 * `https://github.com/acme/web.git` separately).
 */
export function githubTokenEntry(
  repoFullName: string,
  token: string,
  expiresAt: string,
): GithubTokenEntry {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  const config: Array<{ text: string } | { secret: string }> = [];
  for (const url of [
    `https://github.com/${repoFullName}`,
    `https://github.com/${repoFullName}.git`,
  ]) {
    config.push(
      { text: `[http "${url}"]\n\textraheader = AUTHORIZATION: basic ` },
      { secret: basic },
      { text: "\n" },
    );
  }
  return {
    env: {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GH_REPO: [{ text: repoFullName }],
      GIT_CONFIG_GLOBAL: [{ text: GIT_CONFIG_PATH }],
      // A refused token fails Git rather than leaving it waiting for a
      // user name nobody will type.
      GIT_TERMINAL_PROMPT: [{ text: "0" }],
    },
    files: [{ path: GIT_CONFIG_PATH, mode: "600", content: config }],
    "expires-at": Math.floor(Date.parse(expiresAt) / 1000),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `lent.github-token` field for a run, or null when it asks for none
 * or is a fork's. Each set of permissions is minted once; one GitHub will
 * not mint is a refusal its jobs fail with.
 */
export async function lendGithubTokens(
  run: TokenRun,
  access: readonly CiJobAccess[] | null,
  deps: GithubTokenDeps = defaultDeps,
): Promise<Record<string, GithubTokenEntry> | null> {
  if (run.fromFork) return null;
  const requests = githubTokenRequests(access);
  if (requests.size === 0) return null;
  if (isGitSource(run)) {
    // Refused by name, so the job fails saying why rather than running
    // with an empty `GITHUB_TOKEN`.
    return Object.fromEntries(
      [...requests.keys()]
        .slice(0, MAX_ENTRIES)
        .map((key) => [
          key,
          refused(
            `${run.repoFullName} is on git.infrawrench.com, so there is no GitHub token to lend it; \`github-token:\` is for repositories on GitHub`,
          ),
        ]),
    );
  }
  const [accountLogin, repository] = run.repoFullName.split("/");
  const out: Record<string, GithubTokenEntry> = {};
  let granted: Record<string, string> | null | undefined;
  const lent: string[] = [];
  for (const [key, wanted] of [...requests].slice(0, MAX_ENTRIES)) {
    const unknown = Object.entries(wanted).filter(
      ([name, level]) => !GITHUB_TOKEN_PERMISSIONS[name] || (level !== "read" && level !== "write"),
    );
    if (unknown.length > 0) {
      out[key] = refused(
        `a job's GitHub token cannot have ${unknown.map(([n, l]) => `${n}: ${l}`).join(", ")}`,
      );
      continue;
    }
    if (!repository) {
      out[key] = refused(`${run.repoFullName} is not a repository name`);
      continue;
    }
    granted ??= await deps.installationPermissions(run.installationId).catch(() => null);
    if (granted) {
      const missing = missingPermissions(wanted, granted);
      if (missing.length > 0) {
        out[key] = refused(
          `the Infrawrench GitHub App's installation on ${accountLogin} does not have ${missing.join(", ")}, ` +
            `so it cannot lend a token with it; an owner of ${accountLogin} can grant it from the installation's settings on GitHub`,
        );
        continue;
      }
    }
    const permissions: Record<string, GithubTokenLevel> = {};
    for (const [name, level] of Object.entries(wanted)) {
      permissions[GITHUB_TOKEN_PERMISSIONS[name]!] = level as GithubTokenLevel;
    }
    try {
      const minted = await deps.mint(run.installationId, repository, permissions);
      out[key] = githubTokenEntry(run.repoFullName, minted.token, minted.expiresAt);
      lent.push(key);
    } catch (err) {
      out[key] = refused(`GitHub would not mint a token for ${run.repoFullName}: ${message(err)}`);
    }
  }
  await auditTokens(run, lent);
  return out;
}

/** One audit entry per token, against the installation; no person allowed it, the pipeline asked. */
async function auditTokens(run: TokenRun, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db
    .insert(auditLogs)
    .values(
      keys.map((key) => ({
        id: crypto.randomUUID(),
        organizationId: run.organizationId,
        userId: null,
        action: "ci.lend",
        entityType: "github_installation",
        entityId: String(run.installationId),
        metadata: {
          runId: run.id,
          repo: run.repoFullName,
          branch: run.headRef,
          kind: "github-token",
          name: key,
          lent: `a GitHub token for ${run.repoFullName} with ${key}`,
        },
      })),
    )
    .catch((err: unknown) => console.warn("[ci] could not audit GitHub tokens:", err));
}
