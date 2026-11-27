/**
 * Taking a ref and a path back apart from a URL.
 *
 * `/tree/feature/x/src/a.ts` does not say where the ref ends. It is resolved
 * the way the worker resolves raw file paths (`urls.ts` in the contract): a
 * first segment that is a full commit id is the ref; otherwise the longest
 * leading run of segments that names a branch or tag; otherwise the first
 * segment alone (an abbreviated commit id, or a ref the list did not carry),
 * which the API then accepts or answers 404 for.
 */

export interface RefAndPath {
  readonly ref: string;
  readonly path: string;
}

const FULL_OID = /^[0-9a-f]{40}$/;

export function splitRefPath(splat: string, refNames: Iterable<string>): RefAndPath {
  const segments = splat.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return { ref: "", path: "" };
  const first = segments[0]!;
  if (FULL_OID.test(first)) return { ref: first, path: segments.slice(1).join("/") };
  const names = refNames instanceof Set ? (refNames as Set<string>) : new Set(refNames);
  for (let length = segments.length; length >= 1; length--) {
    const candidate = segments.slice(0, length).join("/");
    if (names.has(candidate)) return { ref: candidate, path: segments.slice(length).join("/") };
  }
  return { ref: first, path: segments.slice(1).join("/") };
}

export interface CompareRefs {
  readonly base: string | null;
  readonly head: string;
}

/**
 * `base...head` from a compare URL. A ref name never contains two dots in a
 * row, so the first `...` is the separator whatever slashes surround it.
 * `head` alone compares against the default branch (`base: null`).
 */
export function parseCompare(splat: string): CompareRefs | null {
  const text = splat.replace(/^\/+|\/+$/g, "");
  if (text === "") return null;
  const at = text.indexOf("...");
  if (at < 0) return { base: null, head: text };
  const base = text.slice(0, at);
  const head = text.slice(at + 3);
  if (base === "" || head === "") return null;
  return { base, head };
}

/** The head of a comparison: a ref, and the repository it is in when that is not the base's. */
export interface CompareHead {
  /** Null for the base repository itself. */
  readonly repository: { readonly owner: string; readonly repo: string } | null;
  readonly ref: string;
}

/**
 * A comparison's head as URLs write it: `feature/x` in the base repository,
 * `owner/name:feature/x` in a fork. A ref name never contains a colon, so the
 * first one ends the repository.
 */
export function parseHead(head: string): CompareHead {
  const at = head.indexOf(":");
  if (at < 0) return { repository: null, ref: head };
  const [owner, repo, ...rest] = head.slice(0, at).split("/");
  const ref = head.slice(at + 1);
  if (owner === undefined || owner === "" || repo === undefined || repo === "" || rest.length > 0) {
    return { repository: null, ref: head };
  }
  return { repository: { owner, repo }, ref };
}

/** The reverse of {@link parseHead}. A head in `base` itself is written bare. */
export function formatHead(
  base: { readonly owner: string; readonly repo: string },
  head: CompareHead,
): string {
  const { repository, ref } = head;
  if (
    repository === null ||
    (repository.owner.toLowerCase() === base.owner.toLowerCase() &&
      repository.repo.toLowerCase() === base.repo.toLowerCase())
  ) {
    return ref;
  }
  return `${repository.owner}/${repository.repo}:${ref}`;
}

/** The compare and create requests' `head` and `headRepository` for a parsed head. */
export function headQuery(head: CompareHead): { head: string; headRepository?: string } {
  return head.repository === null
    ? { head: head.ref }
    : { head: head.ref, headRepository: `${head.repository.owner}/${head.repository.repo}` };
}

/** `a/b/c` as `[{ name: "a", path: "a" }, { name: "b", path: "a/b" }, ...]`. */
export function pathCrumbs(path: string): Array<{ name: string; path: string }> {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") }));
}

export const parentPath = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * A relative link or image in a rendered file, as a path from the repository
 * root: `./images/a.png` in `docs/guide.md` is `docs/images/a.png`. Null for
 * anything that is not a path inside the repository (a URL, an anchor, a
 * path that climbs out).
 */
export function resolveRelative(fromFile: string, target: string): string | null {
  if (target === "" || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith("//")) return null;
  const clean = target.split(/[?#]/)[0]!;
  const stack = clean.startsWith("/") ? [] : parentPath(fromFile).split("/").filter(Boolean);
  for (const segment of clean.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(segment);
  }
  return stack.join("/");
}
