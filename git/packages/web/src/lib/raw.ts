/**
 * URLs of file bytes. The worker serves them at the contract's `rawPath`;
 * the dev mock, which has no worker, swaps in a resolver that answers `data:`
 * URLs from its fixtures.
 */
import { rawPath, type RepoRef } from "@infrawrench/git-contract";

type Resolver = (repo: RepoRef, at: string, path: string) => string | null;

let resolver: Resolver | null = null;

/** The dev mock's hook. Nothing else calls this. */
export function setRawResolver(next: Resolver): void {
  resolver = next;
}

/** Where a file's bytes are, at a commit (or any ref). */
export function rawUrl(repo: RepoRef, at: string, path: string): string {
  return resolver?.(repo, at, path) ?? rawPath(repo, at, path);
}

/** A raw URL that downloads rather than displays. */
export function downloadUrl(url: string): string {
  if (url.startsWith("data:")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}
