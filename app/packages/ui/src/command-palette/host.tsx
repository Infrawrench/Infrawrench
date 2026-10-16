import { createContext, useContext, useEffect, type ReactNode } from "react";
import { create } from "zustand";
import {
  starKey,
  type SearchResult,
  type StarRef,
  type StarredItem,
} from "@infrawrench/client-core";

/**
 * The palette's transport to the cloud, supplied per platform: web calls the
 * API directly, the desktop goes through its allowlisted `cloud_palette_*`
 * IPC channels. Absent (desktop local mode) means no server index and no
 * stars; the palette still searches what the host hands it locally.
 */
export interface PaletteClient {
  /** `GET /search?kinds=…`. */
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
  listStarred(): Promise<StarredItem[]>;
  star(ref: StarRef): Promise<StarredItem | null>;
  unstar(ref: StarRef): Promise<void>;
}

export interface PaletteHostValue {
  /** Partitions recents and stars: the org id, or `local`. */
  scope: string;
  client: PaletteClient | null;
}

const PaletteHostContext = createContext<PaletteHostValue | null>(null);

export function PaletteHostProvider({
  value,
  children,
}: {
  value: PaletteHostValue;
  children: ReactNode;
}) {
  return <PaletteHostContext.Provider value={value}>{children}</PaletteHostContext.Provider>;
}

/** Null outside a provider: star buttons render nothing there. */
export function usePaletteHost(): PaletteHostValue | null {
  return useContext(PaletteHostContext);
}

/* ------------------------------------------------------------------ *
 * Starred items: one shared cache so the palette and every page header's
 * star button agree without refetching each other.
 * ------------------------------------------------------------------ */

interface StarredState {
  scope: string | null;
  items: StarredItem[] | null;
  error: string | null;
  /** Keys with a toggle in flight, so a double click cannot race itself. */
  busy: ReadonlySet<string>;
}

export const useStarredStore = create<StarredState>(() => ({
  scope: null,
  items: null,
  error: null,
  busy: new Set(),
}));

let loadSeq = 0;

/** (Re)load the scope's stars. Safe to call repeatedly; the last call wins. */
export async function refreshStarred(host: PaletteHostValue): Promise<void> {
  if (!host.client) return;
  const seq = ++loadSeq;
  if (useStarredStore.getState().scope !== host.scope) {
    useStarredStore.setState({ scope: host.scope, items: null, error: null, busy: new Set() });
  }
  try {
    const items = await host.client.listStarred();
    if (seq === loadSeq) useStarredStore.setState({ scope: host.scope, items, error: null });
  } catch (e) {
    if (seq === loadSeq) {
      useStarredStore.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/**
 * Star or unstar, optimistically. `hit` supplies the row to show until the
 * server's copy arrives (starring from the palette knows it; a page header
 * passes what it renders).
 */
export async function toggleStar(
  host: PaletteHostValue,
  ref: StarRef,
  hit: SearchResult,
): Promise<boolean> {
  const client = host.client;
  if (!client) return false;
  const key = starKey(ref);
  const state = useStarredStore.getState();
  if (state.busy.has(key)) return isStarred(state.items, ref);
  const items = state.scope === host.scope ? (state.items ?? []) : [];
  const was = isStarred(items, ref);
  const optimistic: StarredItem[] = was
    ? items.filter((i) => starKey(i) !== key)
    : [{ ...hit, kind: ref.kind, starredAt: new Date().toISOString() }, ...items];
  useStarredStore.setState({
    scope: host.scope,
    items: optimistic,
    busy: new Set(state.busy).add(key),
  });
  try {
    if (was) {
      await client.unstar(ref);
    } else {
      const saved = await client.star(ref);
      if (saved) {
        useStarredStore.setState((s) => ({
          items: (s.items ?? []).map((i) => (starKey(i) === key ? saved : i)),
        }));
      }
    }
    return !was;
  } catch (e) {
    // Put back what was there; the caller shows the error.
    const original = items.filter((i) => starKey(i) === key);
    useStarredStore.setState((s) => {
      const without = (s.items ?? []).filter((i) => starKey(i) !== key);
      return { items: was ? [...original, ...without] : without };
    });
    throw e;
  } finally {
    useStarredStore.setState((s) => {
      const busy = new Set(s.busy);
      busy.delete(key);
      return { busy };
    });
  }
}

export function isStarred(items: readonly StarredItem[] | null, ref: StarRef): boolean {
  if (!items) return false;
  const key = starKey(ref);
  return items.some((i) => starKey(i) === key);
}

/**
 * The current scope's stars, loading them on first use. Null while loading
 * or without a cloud client.
 */
export function useStarredItems(): StarredItem[] | null {
  const host = usePaletteHost();
  const scope = useStarredStore((s) => s.scope);
  const items = useStarredStore((s) => s.items);
  // Hosts memoize their value, so this runs when the org (or client) changes.
  useEffect(() => {
    if (!host?.client) return;
    const current = useStarredStore.getState();
    if (current.scope !== host.scope || current.items === null) void refreshStarred(host);
  }, [host]);
  return host?.client && scope === host.scope ? items : null;
}
