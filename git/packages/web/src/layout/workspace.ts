/**
 * The reader's workspaces: their own namespace and their organisations',
 * plus any other namespace they have a repository in. One is current, kept
 * in the browser, and it is what the home page and the lists are of.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NamespaceKind, RepositorySummary } from "@infrawrench/git-contract";
import { queries } from "../api/queries";
import { useSession } from "../lib/session";

export interface Workspace {
  readonly slug: string;
  readonly kind: NamespaceKind;
  readonly name: string;
  readonly avatarUrl: string | null;
  /** The repositories of it the reader has a tie to, the most recently pushed first. */
  readonly repositories: ReadonlyArray<RepositorySummary>;
}

const KEY = "git-workspace";
const listeners = new Set<() => void>();
let memory: string | null = null;

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // No storage (a private window): the choice lasts until the tab closes.
    return memory;
  }
}

function write(slug: string): void {
  memory = slug;
  try {
    localStorage.setItem(KEY, slug);
  } catch {
    // Kept in memory, above.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A small remembered open-or-closed flag: a sidebar group. */
export function useStoredFlag(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, () => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Not remembered.
      }
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [stored === null ? initial : stored === "1", set];
}

export interface Workspaces {
  /** Undefined until the session and the repositories are known. */
  readonly workspaces: ReadonlyArray<Workspace> | undefined;
  /** The chosen one, or the first organisation, or the reader's own. */
  readonly current: Workspace | null;
  readonly select: (slug: string) => void;
}

export function useWorkspaces(): Workspaces {
  const session = useSession();
  const signedIn = session.data !== undefined && session.data.user !== null;
  const mine = useQuery({
    ...queries.repositoryLists.listMine({ query: { sort: "pushed", limit: 100 } }),
    enabled: signedIn,
  });
  const chosen = useSyncExternalStore(subscribe, read);
  const data = session.data;
  const repositories = mine.data?.items;

  const workspaces = useMemo(() => {
    if (data === undefined || data.user === null) return undefined;
    if (repositories === undefined && !mine.isError) return undefined;
    const all = repositories ?? [];
    const of = (slug: string) =>
      all.filter((repository) => repository.owner.slug.toLowerCase() === slug.toLowerCase());
    const list: Workspace[] = [];
    for (const organization of data.organizations) {
      if (organization.namespace === null) continue;
      const own = of(organization.namespace);
      list.push({
        slug: organization.namespace,
        kind: "org",
        name: organization.name,
        avatarUrl: own[0]?.owner.avatarUrl ?? null,
        repositories: own,
      });
    }
    if (data.user.username !== null) {
      list.push({
        slug: data.user.username,
        kind: "user",
        name: data.user.displayName ?? data.user.username,
        avatarUrl: data.user.avatarUrl,
        repositories: of(data.user.username),
      });
    }
    // Somebody else's namespace the reader collaborates in.
    for (const repository of all) {
      const slug = repository.owner.slug;
      if (list.some((workspace) => workspace.slug.toLowerCase() === slug.toLowerCase())) continue;
      list.push({
        slug,
        kind: repository.owner.kind,
        name: repository.owner.displayName ?? slug,
        avatarUrl: repository.owner.avatarUrl,
        repositories: of(slug),
      });
    }
    return list;
  }, [data, repositories, mine.isError]);

  const current =
    workspaces?.find((workspace) => workspace.slug === chosen) ?? workspaces?.[0] ?? null;
  return { workspaces, current, select: write };
}
