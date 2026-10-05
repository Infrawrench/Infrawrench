/**
 * GitHub REST calls for issue filing and IaC pull requests, made as the org's
 * GitHub App installation (the bot), never as a person.
 *
 * Every endpoint here is from the REST API reference (API version
 * 2022-11-28, sent by `githubInstallationFetch`):
 *
 *   issues        POST/PATCH /repos/{o}/{r}/issues[/{n}], POST …/comments
 *                 needs the installation's `issues: write`
 *   labels        GET /repos/{o}/{r}/labels                  `issues: read`
 *   assignees     GET /repos/{o}/{r}/assignees               `issues: read`
 *   search        GET /search/issues?q=…                     `issues: read`
 *   git data      GET /git/ref, GET /git/trees?recursive=1, POST /git/refs
 *   contents      GET/PUT/DELETE /repos/{o}/{r}/contents/{path}
 *                 refs and contents writes need `contents: write`
 *   pulls         POST /repos/{o}/{r}/pulls                  `pull_requests: write`
 *
 * The one failure worth its own type is a permission the installation does
 * not hold. GitHub answers 403 "Resource not accessible by integration" when
 * the *app* lacks a permission, which is exactly the state of an installation
 * made before issue filing existed until an owner approves the new request.
 * {@link GithubApiError.missingPermission} carries it so the route can answer
 * the structured 409 the UI turns into a "grant the permission" prompt.
 *
 * Everything throws: every caller is either a person waiting on a button or
 * the routing leg, which catches and logs.
 */
import { forgetInstallationToken, githubInstallationFetch } from "./app.js";

export class GithubApiError extends Error {
  readonly status: number | null;
  /** The GitHub permission the installation lacks, when that is the failure. */
  readonly missingPermission: string | null;
  readonly installationId: number;

  constructor(
    message: string,
    installationId: number,
    status: number | null = null,
    missingPermission: string | null = null,
  ) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
    this.installationId = installationId;
    this.missingPermission = missingPermission;
  }
}

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Whether a string is a plausible `owner/name`, before it reaches a URL. */
export function isRepoFullName(value: string): boolean {
  return REPO_NAME.test(value) && !value.split("/").some((p) => p === "." || p === "..");
}

function repoPath(fullName: string): string {
  if (!isRepoFullName(fullName)) throw new Error(`Invalid repository name: ${fullName}`);
  const [owner, name] = fullName.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function contentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

interface Call {
  installationId: number;
  /** What we were doing, for the message: "create the issue". */
  what: string;
  /** The permission this call needs, reported when GitHub says it is missing. */
  permission: string;
}

async function call<T>(
  c: Call,
  path: string,
  init?: RequestInit & { allow404?: boolean },
): Promise<T | null> {
  let res: Response;
  try {
    res = await githubInstallationFetch(c.installationId, path, {
      ...init,
      ...(init?.body ? { headers: { "Content-Type": "application/json" } } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GithubApiError(`Could not reach GitHub to ${c.what}: ${reason}`, c.installationId);
  }
  if (res.status === 404 && init?.allow404) return null;
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  if (res.ok) {
    return text ? (JSON.parse(text) as T) : null;
  }
  let message = "";
  try {
    const parsed = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }> };
    message = [parsed.message, ...(parsed.errors ?? []).map((e) => e.message)]
      .filter(Boolean)
      .join("; ");
  } catch {
    message = text.slice(0, 200);
  }
  if (res.status === 403 && /not accessible by integration/i.test(message)) {
    // The token may predate an approval; mint a fresh one next time.
    forgetInstallationToken(c.installationId);
    throw new GithubApiError(
      `The GitHub App installation has not been granted "${c.permission}" write access, so it cannot ${c.what}. An owner of the GitHub account needs to approve the app's updated permissions.`,
      c.installationId,
      403,
      c.permission,
    );
  }
  if (res.status === 404) {
    throw new GithubApiError(
      `GitHub could not find that (or the app cannot see it) while trying to ${c.what}.`,
      c.installationId,
      404,
    );
  }
  if (res.status === 410) {
    throw new GithubApiError(
      `Issues are disabled on that repository, so GitHub refused to ${c.what}.`,
      c.installationId,
      410,
    );
  }
  throw new GithubApiError(
    `GitHub refused to ${c.what} (HTTP ${res.status})${message ? `: ${message}` : ""}`,
    c.installationId,
    res.status,
  );
}

// --- Issues ---

export interface GithubIssueRef {
  number: number;
  url: string;
  state: "open" | "closed";
}

function toIssueRef(body: { number?: number; html_url?: string; state?: string }): GithubIssueRef {
  return {
    number: body.number ?? 0,
    url: body.html_url ?? "",
    state: body.state === "closed" ? "closed" : "open",
  };
}

export async function createIssue(
  installationId: number,
  repo: string,
  input: { title: string; body: string; labels: string[]; assignees: string[] },
): Promise<GithubIssueRef> {
  const body = await call<{ number?: number; html_url?: string; state?: string }>(
    { installationId, what: "create the issue", permission: "issues" },
    `${repoPath(repo)}/issues`,
    {
      method: "POST",
      body: JSON.stringify({
        title: input.title.slice(0, 256),
        body: input.body,
        ...(input.labels.length > 0 ? { labels: input.labels } : {}),
        ...(input.assignees.length > 0 ? { assignees: input.assignees } : {}),
      }),
    },
  );
  if (!body?.number || !body.html_url) {
    throw new GithubApiError("GitHub accepted the issue but returned no number", installationId);
  }
  return toIssueRef(body);
}

/** One issue, or null when it no longer exists (deleted or transferred away). */
export async function getIssue(
  installationId: number,
  repo: string,
  issueNumber: number,
): Promise<GithubIssueRef | null> {
  const body = await call<{ number?: number; html_url?: string; state?: string }>(
    { installationId, what: "read the issue", permission: "issues" },
    `${repoPath(repo)}/issues/${issueNumber}`,
    { allow404: true },
  );
  return body ? toIssueRef(body) : null;
}

export async function commentOnIssue(
  installationId: number,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await call(
    { installationId, what: "comment on the issue", permission: "issues" },
    `${repoPath(repo)}/issues/${issueNumber}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export async function closeIssue(
  installationId: number,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await call(
    { installationId, what: "close the issue", permission: "issues" },
    `${repoPath(repo)}/issues/${issueNumber}`,
    { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) },
  );
}

/**
 * An open issue in `repo` whose body carries `marker`, via the search API.
 * The fallback half of dedupe: it finds an issue our link table lost (a
 * restored database, a link written by another org's install of the same
 * repo). Search is eventually consistent and rate limited separately, so a
 * failure here answers null rather than blocking the filing.
 */
export async function findOpenIssueByMarker(
  installationId: number,
  repo: string,
  marker: string,
): Promise<GithubIssueRef | null> {
  if (!isRepoFullName(repo)) return null;
  const q = `repo:${repo} is:issue is:open in:body "${marker.replace(/"/g, "")}"`;
  try {
    const body = await call<{
      items?: Array<{ number?: number; html_url?: string; state?: string }>;
    }>(
      { installationId, what: "search issues", permission: "issues" },
      `/search/issues?q=${encodeURIComponent(q)}&per_page=5`,
    );
    const hit = body?.items?.find((i) => i.state === "open" && i.number && i.html_url);
    return hit ? toIssueRef(hit) : null;
  } catch (err) {
    if (err instanceof GithubApiError && err.missingPermission) throw err;
    console.warn(`[github-issues] marker search failed in ${repo}:`, err);
    return null;
  }
}

export async function listLabels(
  installationId: number,
  repo: string,
): Promise<Array<{ name: string; color: string; description: string | null }>> {
  const out: Array<{ name: string; color: string; description: string | null }> = [];
  for (let page = 1; page <= 5; page++) {
    const body = await call<Array<{ name?: string; color?: string; description?: string | null }>>(
      { installationId, what: "list labels", permission: "issues" },
      `${repoPath(repo)}/labels?per_page=100&page=${page}`,
    );
    const rows = body ?? [];
    for (const l of rows) {
      if (l.name)
        out.push({ name: l.name, color: l.color ?? "", description: l.description ?? null });
    }
    if (rows.length < 100) break;
  }
  return out;
}

export async function listAssignees(
  installationId: number,
  repo: string,
): Promise<Array<{ login: string; avatarUrl: string | null }>> {
  const out: Array<{ login: string; avatarUrl: string | null }> = [];
  for (let page = 1; page <= 5; page++) {
    const body = await call<Array<{ login?: string; avatar_url?: string }>>(
      { installationId, what: "list assignees", permission: "issues" },
      `${repoPath(repo)}/assignees?per_page=100&page=${page}`,
    );
    const rows = body ?? [];
    for (const a of rows) {
      if (a.login) out.push({ login: a.login, avatarUrl: a.avatar_url ?? null });
    }
    if (rows.length < 100) break;
  }
  return out;
}

// --- Repository contents, for IaC pull requests ---

/** Branch names, for the base-branch picker. */
export async function listBranches(installationId: number, repo: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const body = await call<Array<{ name?: string }>>(
      { installationId, what: "list branches", permission: "contents" },
      `${repoPath(repo)}/branches?per_page=100&page=${page}`,
    );
    const rows = body ?? [];
    for (const b of rows) if (b.name) out.push(b.name);
    if (rows.length < 100) break;
  }
  return out;
}

export async function getDefaultBranch(installationId: number, repo: string): Promise<string> {
  const body = await call<{ default_branch?: string }>(
    { installationId, what: "read the repository", permission: "contents" },
    repoPath(repo),
  );
  return body?.default_branch ?? "main";
}

export async function getBranchSha(
  installationId: number,
  repo: string,
  branch: string,
): Promise<string> {
  const body = await call<{ object?: { sha?: string } }>(
    { installationId, what: `read branch ${branch}`, permission: "contents" },
    `${repoPath(repo)}/git/ref/heads/${contentPath(branch)}`,
  );
  const sha = body?.object?.sha;
  if (!sha) throw new GithubApiError(`Branch ${branch} has no head commit`, installationId);
  return sha;
}

/** Blob paths under `directory` at `sha` (non-recursive into nested modules). */
export async function listTreeFiles(
  installationId: number,
  repo: string,
  sha: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const body = await call<{ tree?: Array<{ path?: string; type?: string }>; truncated?: boolean }>(
    { installationId, what: "read the repository tree", permission: "contents" },
    `${repoPath(repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
  );
  return {
    paths: (body?.tree ?? [])
      .filter((e) => e.type === "blob" && typeof e.path === "string")
      .map((e) => e.path as string),
    truncated: Boolean(body?.truncated),
  };
}

export async function getFile(
  installationId: number,
  repo: string,
  path: string,
  ref: string,
): Promise<{ content: string; sha: string } | null> {
  const body = await call<{ content?: string; sha?: string; type?: string }>(
    { installationId, what: `read ${path}`, permission: "contents" },
    `${repoPath(repo)}/contents/${contentPath(path)}?ref=${encodeURIComponent(ref)}`,
    { allow404: true },
  );
  if (!body || body.type !== "file" || typeof body.content !== "string" || !body.sha) return null;
  return {
    content: Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8"),
    sha: body.sha,
  };
}

export async function createBranch(
  installationId: number,
  repo: string,
  branch: string,
  sha: string,
): Promise<void> {
  await call(
    { installationId, what: "create a branch", permission: "contents" },
    `${repoPath(repo)}/git/refs`,
    { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) },
  );
}

export async function putFile(
  installationId: number,
  repo: string,
  input: { path: string; branch: string; content: string; sha: string; message: string },
): Promise<void> {
  await call(
    { installationId, what: `commit ${input.path}`, permission: "contents" },
    `${repoPath(repo)}/contents/${contentPath(input.path)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        sha: input.sha,
        branch: input.branch,
      }),
    },
  );
}

export async function deleteFile(
  installationId: number,
  repo: string,
  input: { path: string; branch: string; sha: string; message: string },
): Promise<void> {
  await call(
    { installationId, what: `delete ${input.path}`, permission: "contents" },
    `${repoPath(repo)}/contents/${contentPath(input.path)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ message: input.message, sha: input.sha, branch: input.branch }),
    },
  );
}

export async function createPullRequest(
  installationId: number,
  repo: string,
  input: { title: string; head: string; base: string; body: string },
): Promise<{ number: number; url: string }> {
  const body = await call<{ number?: number; html_url?: string }>(
    { installationId, what: "open the pull request", permission: "pull_requests" },
    `${repoPath(repo)}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title: input.title.slice(0, 256),
        head: input.head,
        base: input.base,
        // Never auto-merged: nothing here enables auto-merge, so a person
        // reviews and merges it, or closes it.
        body: input.body,
      }),
    },
  );
  if (!body?.number || !body.html_url) {
    throw new GithubApiError(
      "GitHub accepted the pull request but returned no number",
      installationId,
    );
  }
  return { number: body.number, url: body.html_url };
}
