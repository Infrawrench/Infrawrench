import { useEffect, useState } from "react";

/**
 * Where the sidebar's Git entry goes: the organisation's namespace on
 * git.infrawrench.com, which is its own site, so the entry is a link out and
 * not a workspace tab. Read once per organisation with the host's `load`
 * (web's fetch, the desktop's cloud client) and shared by the sidebar, the
 * launcher and Home; Settings > Git announces a claim or a rename, so the
 * link follows without a reload.
 */
export type GitForgeLink =
  /** Not known yet: the entry shows and opens Settings > Git until it is. */
  | { status: "loading" }
  /** The organisation's namespace page, or null when none is claimed. */
  | { status: "ready"; url: string | null }
  /** The caller may not read it (no `git:read`), or the read failed: no entry. */
  | { status: "unavailable" };

const GIT_FORGE_NAMESPACE_CHANGED_EVENT = "infrawrench:git-forge-namespace-changed";

const LOADING: GitForgeLink = { status: "loading" };
const known = new Map<string, GitForgeLink>();
const inflight = new Map<string, Promise<GitForgeLink>>();

/** Settings > Git saved a namespace for the organisation in view. */
export function notifyGitForgeNamespaceChanged(url: string): void {
  window.dispatchEvent(new CustomEvent(GIT_FORGE_NAMESPACE_CHANGED_EVENT, { detail: { url } }));
}

function fetchLink(
  scope: string,
  load: () => Promise<{ namespace: { url: string } | null }>,
): Promise<GitForgeLink> {
  const pending = inflight.get(scope);
  if (pending) return pending;
  const request = load()
    .then((overview): GitForgeLink => ({ status: "ready", url: overview.namespace?.url ?? null }))
    .catch((): GitForgeLink => ({ status: "unavailable" }))
    .then((link) => {
      known.set(scope, link);
      inflight.delete(scope);
      return link;
    });
  inflight.set(scope, request);
  return request;
}

/**
 * The Git link for `scope` (an organisation id). A null scope (the desktop's
 * local mode) has no forge namespace: unavailable. `load` must be stable for
 * a scope (`useCallback`).
 */
export function useGitForgeLinkFrom(
  scope: string | null | undefined,
  load: () => Promise<{ namespace: { url: string } | null }>,
): GitForgeLink {
  const [link, setLink] = useState<GitForgeLink>(() =>
    scope ? (known.get(scope) ?? LOADING) : { status: "unavailable" },
  );

  useEffect(() => {
    if (!scope) {
      setLink({ status: "unavailable" });
      return;
    }
    let cancelled = false;
    setLink(known.get(scope) ?? LOADING);
    void fetchLink(scope, load).then((next) => {
      if (!cancelled) setLink(next);
    });
    const onChanged = (event: Event) => {
      const url = (event as CustomEvent<{ url?: unknown } | undefined>).detail?.url;
      if (typeof url !== "string") return;
      const next: GitForgeLink = { status: "ready", url };
      known.set(scope, next);
      setLink(next);
    };
    window.addEventListener(GIT_FORGE_NAMESPACE_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(GIT_FORGE_NAMESPACE_CHANGED_EVENT, onChanged);
    };
  }, [scope, load]);

  return link;
}
