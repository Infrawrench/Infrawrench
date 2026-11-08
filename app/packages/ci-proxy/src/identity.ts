// Who a run belongs to, worked out the way the runner does
// (`ci-runner/crates/iwci/src/runner.rs`, `RunRequest::owner` and
// `RunRequest::repo_id`, and `adapters/caches.rs`'s `owner_from_url`), so the
// secrets and variables the proxy looks up are the ones the run's owner and
// repository set. `__tests__/identity.test.ts` has the runner's cases.

const ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Whether `id` is a valid owner or repository id (`RepoId::new`). */
export function isId(id: string): boolean {
  return ID.test(id) && !id.includes("..");
}

function clean(text: string): string {
  return text
    .toLowerCase()
    .split("")
    .map((c) => (/[a-z0-9._-]/.test(c) ? c : "_"))
    .join("");
}

/** `github.com-acme` from `https://github.com/acme/web`, or `null`. */
export function ownerFromUrl(url: string): string | null {
  const schemeAt = url.indexOf("://");
  const scp = schemeAt < 0;
  let rest = scp ? url : url.slice(schemeAt + 3);
  const at = rest.lastIndexOf("@");
  if (at >= 0) rest = rest.slice(at + 1);
  const split = rest.indexOf(scp ? ":" : "/");
  if (split < 0) return null;
  const host = rest.slice(0, split).split(":")[0] ?? "";
  const org =
    rest
      .slice(split + 1)
      .replace(/^\/+/, "")
      .split("/")[0] ?? "";
  if (host.length === 0 || org.length === 0) return null;
  const owner = clean(`${host}-${org}`);
  return isId(owner) ? owner : null;
}

/** `web` from `https://github.com/acme/web.git`. */
export function repoIdFromUrl(url: string): string {
  const name = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return clean(name.endsWith(".git") ? name.slice(0, -4) : name);
}

/** The owner and repository id of a run request. */
export function identify(body: Record<string, unknown>): { owner: string; repoId: string } {
  const repo = typeof body.repo === "string" ? body.repo : "";
  const owner = typeof body.owner === "string" ? body.owner : (ownerFromUrl(repo) ?? "local");
  const repoId = typeof body["repo-id"] === "string" ? body["repo-id"] : repoIdFromUrl(repo);
  return { owner, repoId };
}
