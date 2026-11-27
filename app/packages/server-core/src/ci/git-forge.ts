/**
 * The few reads the app makes of a git.infrawrench.com repository itself,
 * for CI: a branch's head (a manual run), one file at a commit
 * (`env-file:`), and the link a cloud job's machine downloads the commit
 * from. Each is authorised with a short-lived, read-only job token for that
 * one repository (`source.ts`), the same credential a runner clones with.
 *
 * The forge's Worker serves these (`git/packages/worker/NOTES-ci.md` lists
 * exactly what it must answer). A branch's head is read over smart HTTP,
 * protocol v2 `ls-refs`, which the forge serves for every git client
 * anyway, so it needs no route of its own.
 */
import { gitBaseUrl, mintGitJobToken, SHORT_TOKEN_TTL_SECONDS } from "./source.js";

const SHA = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 20_000;
/** A branch's refs are a line each; anything near this is not an answer to the question asked. */
const MAX_REFS_BYTES = 256 * 1024;
/** `.infraenv` files are small; the reader refuses more than this long before. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function repoPath(repoFullName: string): string {
  return repoFullName.split("/").map(encodeURIComponent).join("/");
}

/** One pkt-line: four hex digits of length (itself included), then the data. */
export function pktLine(data: string): string {
  const length = new TextEncoder().encode(data).length + 4;
  return length.toString(16).padStart(4, "0") + data;
}

/** The body of a protocol v2 `ls-refs` asking for the refs under `prefix`. */
export function lsRefsRequest(prefix: string): string {
  return (
    pktLine("command=ls-refs\n") +
    pktLine("agent=infrawrench-ci\n") +
    // The delimiter between capabilities and arguments, then the flush.
    "0001" +
    pktLine(`ref-prefix ${prefix}\n`) +
    "0000"
  );
}

/** The refs an `ls-refs` answer lists, by name. Lines that are not refs are skipped. */
export function parseLsRefs(body: string): Map<string, string> {
  const refs = new Map<string, string>();
  let at = 0;
  while (at + 4 <= body.length) {
    const length = Number.parseInt(body.slice(at, at + 4), 16);
    if (!Number.isFinite(length)) break;
    // 0000 flush, 0001 delimiter, 0002 response end: no data.
    if (length < 4) {
      at += 4;
      continue;
    }
    const line = body.slice(at + 4, at + length).replace(/\n$/, "");
    at += length;
    const space = line.indexOf(" ");
    if (space !== 40) continue;
    const oid = line.slice(0, 40);
    // `<oid> <name>[ <attribute>...]`: a ref name has no space.
    const name = line.slice(41).split(" ")[0] ?? "";
    if (SHA.test(oid) && name.length > 0) refs.set(name, oid);
  }
  return refs;
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) return null;
  return new TextDecoder().decode(bytes);
}

/** Git's Basic auth for a token: any user name, the token as the password. */
function basic(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

/**
 * The commit `branch` points at, or `null` when the repository has no such
 * branch. Throws when the forge cannot be asked, which is not "no branch".
 */
export async function gitBranchHead(
  repo: { gitRepositoryId: string; repoFullName: string },
  branch: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const token = await mintGitJobToken(repo.gitRepositoryId, "manual", {
    ttlSeconds: SHORT_TOKEN_TTL_SECONDS,
  });
  const ref = `refs/heads/${branch}`;
  const res = await fetcher(`${gitBaseUrl()}/${repoPath(repo.repoFullName)}.git/git-upload-pack`, {
    method: "POST",
    headers: {
      Authorization: basic(token),
      "Git-Protocol": "version=2",
      "Content-Type": "application/x-git-upload-pack-request",
      Accept: "application/x-git-upload-pack-result",
      "User-Agent": "infrawrench-ci",
    },
    body: lsRefsRequest(ref),
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `git.infrawrench.com answered ${res.status} for the branches of ${repo.repoFullName}`,
    );
  }
  const body = await readCapped(res, MAX_REFS_BYTES);
  if (body === null) throw new Error("git.infrawrench.com listed more refs than were asked for");
  // `ref-prefix` matches `main` and `main-2` alike: only the exact name counts.
  return parseLsRefs(body).get(ref) ?? null;
}

/**
 * A file's text at a commit, or `null` when the commit has no such file.
 * `GET /<owner>/<repo>/raw/<sha>/<path>` with the job token as a Bearer
 * token.
 */
export async function gitReadFile(
  repo: { gitRepositoryId: string; repoFullName: string },
  path: string,
  sha: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  if (!SHA.test(sha)) return null;
  const token = await mintGitJobToken(repo.gitRepositoryId, "env-file", {
    ttlSeconds: SHORT_TOKEN_TTL_SECONDS,
  });
  const file = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
  const res = await fetcher(`${gitBaseUrl()}/${repoPath(repo.repoFullName)}/raw/${sha}/${file}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "infrawrench-ci" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`git.infrawrench.com answered ${res.status} for ${path}`);
  }
  const text = await readCapped(res, MAX_FILE_BYTES);
  if (text === null) throw new Error(`${path} is too large to read`);
  return text;
}

/**
 * Where a cloud job's machine downloads the commit: the forge's source
 * archive (a gzipped tar with one top-level directory, as GitHub's is), with
 * a job token of its own in the query. The machine follows this as a
 * redirect and sends no header of its own, which is why the token is in the
 * link. That token is bound to the commit: for ten minutes it downloads
 * this one archive, and the forge refuses it for a clone, a file or any
 * other commit, the same exposure as GitHub's own short-lived archive link.
 */
export async function gitArchiveLink(
  repo: { gitRepositoryId: string; repoFullName: string },
  sha: string,
  purpose: string,
): Promise<string> {
  if (!SHA.test(sha)) throw new Error("That is not a commit.");
  const token = await mintGitJobToken(repo.gitRepositoryId, purpose, {
    ttlSeconds: SHORT_TOKEN_TTL_SECONDS,
    commit: sha,
  });
  return `${gitBaseUrl()}/${repoPath(repo.repoFullName)}/archive/${sha}.tar.gz?token=${encodeURIComponent(token)}`;
}
