/**
 * GitHub App auth + REST helpers.
 *
 * The app authenticates as itself with a short-lived RS256 JWT (signed with the
 * app private key), exchanges that for per-installation tokens, and uses those
 * to act as the bot on a user's repos. Used by the web API (connect + list
 * repos) and the github-watcher service (read branch heads).
 *
 * Config (env):
 *   GITHUB_APP_ID            — the app's numeric id
 *   GITHUB_APP_PRIVATE_KEY   — PEM private key (literal newlines or \n-escaped)
 *   GITHUB_APP_SLUG          — the app's URL slug (for the install link)
 */
import { createSign, createHmac, createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com";

function appId(): string {
  const v = process.env["GITHUB_APP_ID"];
  if (!v) throw new Error("GITHUB_APP_ID is not configured.");
  return v;
}

function privateKey(): string {
  const v = process.env["GITHUB_APP_PRIVATE_KEY"];
  if (!v) throw new Error("GITHUB_APP_PRIVATE_KEY is not configured.");
  // Allow the PEM to be stored with escaped newlines in a single env line.
  return v.includes("\\n") ? v.replace(/\\n/g, "\n") : v;
}

export function githubAppSlug(): string | null {
  return process.env["GITHUB_APP_SLUG"] ?? null;
}

/** Whether the GitHub App is configured (id + key present). */
export function isGithubAppConfigured(): boolean {
  return Boolean(process.env["GITHUB_APP_ID"] && process.env["GITHUB_APP_PRIVATE_KEY"]);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** A ~9-minute app JWT (RS256), `iss` = app id. */
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId() }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey()).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function gh(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "infrawrench",
      ...(init?.headers ?? {}),
    },
  });
}

// installationId -> { token, expiresAt }. GitHub installation tokens last ~1h.
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** A short-lived token scoped to one installation (cached until ~1 min before expiry). */
export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const res = await gh(appJwt(), `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`GitHub installation token failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}

export interface GithubRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** All repositories the installation can access. */
export async function listInstallationRepos(installationId: number): Promise<GithubRepo[]> {
  const token = await getInstallationToken(installationId);
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh(token, `/installation/repositories?per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`GitHub repo list failed (${res.status})`);
    const body = (await res.json()) as {
      repositories: Array<{
        id: number;
        full_name: string;
        default_branch: string;
        private: boolean;
      }>;
    };
    for (const r of body.repositories) {
      repos.push({
        id: r.id,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
      });
    }
    if (body.repositories.length < 100) break;
  }
  return repos;
}

/** Latest commit SHA on a branch, or null when the repo/branch can't be read. */
export async function getBranchHeadSha(
  installationId: number,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const token = await getInstallationToken(installationId);
  const res = await gh(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub branch read failed (${res.status})`);
  const body = (await res.json()) as { commit?: { sha?: string } };
  return body.commit?.sha ?? null;
}

/** The account an installation belongs to (used to label the connection). */
export async function getInstallation(
  installationId: number,
): Promise<{ accountLogin: string | null; accountType: string | null } | null> {
  const res = await gh(appJwt(), `/app/installations/${installationId}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { account?: { login?: string; type?: string } };
  return { accountLogin: body.account?.login ?? null, accountType: body.account?.type ?? null };
}

// --- Signed state for the install round-trip (binds the install to an org) ---

function stateKey(): Buffer {
  // Derive a stable server-side HMAC key from the app private key so the
  // install `state` can't be forged to attach an installation to another org.
  return createHash("sha256").update(privateKey()).digest();
}

export interface InstallState {
  organizationId: string;
  /** Where in the app to send the user back to after the install (e.g. "agents"). */
  returnTo: string | null;
}

export function signInstallState(organizationId: string, returnTo?: string): string {
  const payload = JSON.stringify({ o: organizationId, ...(returnTo ? { r: returnTo } : {}) });
  const mac = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  return `${b64url(payload)}.${mac}`;
}

export function verifyInstallState(state: string): InstallState | null {
  const [payloadB64, mac] = state.split(".");
  if (!payloadB64 || !mac) return null;
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  if (mac !== expected) return null;
  try {
    const parsed = JSON.parse(payload) as { o?: string; r?: string };
    if (!parsed.o) return null;
    return { organizationId: parsed.o, returnTo: parsed.r ?? null };
  } catch {
    // Pre-returnTo states signed the bare org id.
    return { organizationId: payload, returnTo: null };
  }
}
