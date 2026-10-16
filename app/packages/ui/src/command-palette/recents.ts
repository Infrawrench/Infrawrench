import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getWorkspaceTabId, useUIStore, type WorkspaceTabTarget } from "../store/ui.store.js";

/**
 * Recently opened tabs, per viewer and per org (or `local` for the desktop's
 * local workspace), most recent first.
 *
 * Kept in browser storage rather than on the server: there is no per-user
 * preference store to put it in, and "what did I just have open" is about
 * this device anyway. Both apps record through {@link useRecordRecentTabs},
 * which watches the active workspace tab, so anything opened by any route
 * (sidebar, palette, deep link, tab strip) counts, with no call site to
 * forget.
 */
export interface RecentEntry {
  /** `getWorkspaceTabId(target)`: the dedupe key. */
  id: string;
  target: WorkspaceTabTarget;
  title: string;
  /** Epoch ms of the last activation. */
  at: number;
}

export const MAX_RECENTS = 20;

interface RecentsState {
  byScope: Record<string, RecentEntry[]>;
  record: (scope: string, target: WorkspaceTabTarget, title: string) => void;
  forget: (scope: string, id: string) => void;
}

/** Pure: put `entry` first, dropping its older copy and the overflow. */
export function pushRecent(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, MAX_RECENTS);
}

export const useRecentsStore = create<RecentsState>()(
  persist(
    (set) => ({
      byScope: {},
      record: (scope, target, title) =>
        set((s) => {
          const id = getWorkspaceTabId(target);
          const list = s.byScope[scope] ?? [];
          // Same tab, same title, already first: nothing to write.
          if (list[0]?.id === id && list[0].title === title) return s;
          return {
            byScope: {
              ...s.byScope,
              [scope]: pushRecent(list, { id, target, title, at: Date.now() }),
            },
          };
        }),
      forget: (scope, id) =>
        set((s) => ({
          byScope: { ...s.byScope, [scope]: (s.byScope[scope] ?? []).filter((e) => e.id !== id) },
        })),
    }),
    {
      name: "infrawrench-palette-recents",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ byScope: s.byScope }),
    },
  ),
);

/** The recents for one scope, most recent first. */
export function useRecents(scope: string | null): RecentEntry[] {
  return useRecentsStore((s) => (scope ? (s.byScope[scope] ?? EMPTY) : EMPTY));
}

const EMPTY: RecentEntry[] = [];

/**
 * Record the active workspace tab into `scope`'s recents whenever it changes
 * (or is retitled, which is how a tab's placeholder title becomes the object's
 * name). Mount once per shell; a null scope records nothing.
 */
export function useRecordRecentTabs(scope: string | null): void {
  const active = useUIStore((s) =>
    s.activeWorkspaceTabId
      ? (s.workspaceTabs.find((t) => t.id === s.activeWorkspaceTabId) ?? null)
      : null,
  );
  const record = useRecentsStore((s) => s.record);
  useEffect(() => {
    if (!scope || !active || !active.title) return;
    record(scope, active.target, active.title);
  }, [scope, active, record]);
}
