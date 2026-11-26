/**
 * The site's URL schemes outside the JSON API: sign-in, clone, raw files and
 * archives. They are plain paths the browser, `git` and `curl` use directly,
 * so they are functions here rather than `HttpApi` endpoints; the worker's
 * router and the UI's links both build them from this file.
 *
 * | Path                                         | What                                             |
 * | -------------------------------------------- | ------------------------------------------------ |
 * | `/auth/sign-in?returnTo=`                    | Redirects to WorkOS AuthKit.                     |
 * | `/auth/callback`                             | AuthKit's redirect; sets the session cookie.     |
 * | `/auth/sign-out`                             | `POST`; the API's `session.signOut` does the same. |
 * | `/:owner/:repo.git/...`                      | Smart HTTP (`info/refs`, `git-upload-pack`, ...). |
 * | `/:owner/:repo/raw/:ref/*path`               | A file's bytes.                                  |
 * | `/:owner/:repo/archive/:ref.tar.gz` / `.zip` | The tree at a ref as an archive.                 |
 * | `/:owner/:repo/terraform/:workspace/state`   | Terraform's HTTP state backend (`/lock`, `/unlock`). |
 *
 * **Refs in a path.** A ref name contains slashes, so `raw/feature/x/src/a.ts`
 * is ambiguous on its face. The server resolves it the way every forge does:
 * a 40-hex first segment is a commit id; otherwise the longest prefix of the
 * segments that names a branch, then a tag. Links the UI generates for
 * content it has already resolved use the commit id, which is never
 * ambiguous and can be cached forever.
 */

export const SITE_ORIGIN = "https://git.infrawrench.com";
export const SSH_HOST = "git.infrawrench.com";
export const SSH_USER = "git";

export const AUTH_PATHS = {
  signIn: "/auth/sign-in",
  callback: "/auth/callback",
  signOut: "/auth/sign-out",
} as const;

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

const segment = (value: string): string => encodeURIComponent(value);

/** Encode a ref or tree path for a URL path, keeping its slashes. */
export const encodePathSegments = (path: string): string => path.split("/").map(segment).join("/");

/** `/auth/sign-in?returnTo=...`. `returnTo` is a path on this site; anything else is ignored. */
export const signInPath = (returnTo?: string): string =>
  returnTo === undefined
    ? AUTH_PATHS.signIn
    : `${AUTH_PATHS.signIn}?returnTo=${encodeURIComponent(returnTo)}`;

export const repositoryPath = ({ owner, repo }: RepoRef): string =>
  `/${segment(owner)}/${segment(repo)}`;

/** `https://git.infrawrench.com/owner/repo.git` */
export const httpCloneUrl = (ref: RepoRef, origin: string = SITE_ORIGIN): string =>
  `${origin}${repositoryPath(ref)}.git`;

/**
 * `git@git.infrawrench.com:owner/repo.git`. `host` is the worker's `SSH_HOST`
 * variable, the one place the SSH endpoint is named. With a port
 * (`127.0.0.1:8788`, local development) the scp-like form has nowhere to put
 * it, so the URL is `ssh://git@127.0.0.1:8788/owner/repo.git`.
 */
export const sshCloneUrl = ({ owner, repo }: RepoRef, host: string = SSH_HOST): string =>
  /:\d+$/.test(host)
    ? `ssh://${SSH_USER}@${host}/${owner}/${repo}.git`
    : `${SSH_USER}@${host}:${owner}/${repo}.git`;

/**
 * A file's bytes: `/owner/repo/raw/<ref>/<path>`. Served with the file's
 * guessed content type for images, audio, video and PDF, and as
 * `text/plain; charset=utf-8` (or `application/octet-stream`) for everything
 * else, with `Content-Security-Policy: sandbox` and `X-Content-Type-Options:
 * nosniff`, so a repository can never serve a page on this origin. Add
 * `?download=1` for `Content-Disposition: attachment`.
 */
export const rawPath = (
  ref: RepoRef,
  at: string,
  path: string,
  options: { readonly download?: boolean } = {},
): string =>
  `${repositoryPath(ref)}/raw/${encodePathSegments(at)}/${encodePathSegments(path)}${
    options.download === true ? "?download=1" : ""
  }`;

export const ARCHIVE_FORMATS = ["tar.gz", "zip"] as const;
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];

/**
 * The tree at a ref as an archive: `/owner/repo/archive/<ref>.tar.gz` or
 * `.zip`. Every entry sits under one top-level directory, `<repo>-<ref>` with
 * the ref's slashes as dashes. `path` narrows it to a subtree.
 */
export const archivePath = (
  ref: RepoRef,
  at: string,
  format: ArchiveFormat,
  options: { readonly path?: string } = {},
): string =>
  `${repositoryPath(ref)}/archive/${encodePathSegments(at)}.${format}${
    options.path === undefined || options.path === ""
      ? ""
      : `?path=${encodeURIComponent(options.path)}`
  }`;

/** Terraform's `backend "http"` address for a workspace; `lock_address` and `unlock_address` add `/lock` and `/unlock`. */
export const terraformStatePath = (ref: RepoRef, workspace: string): string =>
  `${repositoryPath(ref)}/terraform/${segment(workspace)}/state`;

/** The personal access token prefix (`iwg_`), for forms that recognise a pasted one. */
export const ACCESS_TOKEN_PREFIX = "iwg_";
