import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useGT, useMessages } from "gt-react";
import {
  fuzzyFilter,
  fuzzyScore,
  searchResultKind,
  starKey,
  type SearchResult,
  type SearchResultKind,
  type StarRef,
} from "@infrawrench/client-core";
import type { WorkspaceTabTarget } from "../store/ui.store.js";
import { useDataString } from "../i18n/data-strings.js";
import { toast } from "../components/Toast/useToast.js";
import { formatErrorMessage } from "../utils.js";
import type { PaletteAction } from "./actions.js";
import { isStarred, toggleStar, usePaletteHost, useStarredItems } from "./host.js";
import { requestPaletteIntent } from "./intents.js";
import {
  PALETTE_KIND_GROUP_LABELS,
  PaletteKindIcon,
  paletteDestination,
  starRefFromTarget,
} from "./kinds.js";
import { modKeyPrefix } from "./keys.js";
import { useRecents, type RecentEntry } from "./recents.js";
import { starHit } from "./StarButton.js";

/** Keystrokes settle this long before the server is asked. */
export const PALETTE_SEARCH_DEBOUNCE_MS = 150;

const MAX_STARRED_SHOWN = 12;
const MAX_RECENTS_SHOWN = 8;
const MAX_ACTIONS_WITH_QUERY = 4;
const MAX_LOCAL_HITS = 50;

export interface CommandPaletteProps {
  onClose: () => void;
  actions: readonly PaletteAction[];
  /** Open a workspace tab: in the active tab, or a new one (`newTab`). */
  onOpenTarget: (target: WorkspaceTabTarget, label: string, options: { newTab: boolean }) => void;
  /**
   * Hits the host searches itself (the desktop's local resources and
   * workflows), filtered and ranked here with the same matcher the server
   * uses.
   */
  localResults?: readonly SearchResult[] | undefined;
  localLoading?: boolean | undefined;
  /**
   * Which objects may be starred. Stars live on the server, so the desktop
   * passes saved objects only: its local resources may not exist in the org.
   */
  canStar?: ((ref: StarRef) => boolean) | undefined;
}

type Row =
  | { key: string; type: "hit"; hit: SearchResult; ref: StarRef }
  | { key: string; type: "recent"; entry: RecentEntry; ref: StarRef | null }
  | { key: string; type: "action"; action: PaletteAction };

interface Group {
  id: string;
  label: string;
  icon: SearchResultKind | "action" | "recent" | "starred";
  rows: Row[];
}

function hitRow(hit: SearchResult, prefix = "hit"): Row {
  const kind = searchResultKind(hit);
  return {
    key: `${prefix}:${kind}:${hit.id}`,
    type: "hit",
    hit,
    ref: { kind, id: hit.id },
  };
}

function recentRow(entry: RecentEntry): Row {
  return { key: `recent:${entry.id}`, type: "recent", entry, ref: starRefFromTarget(entry.target) };
}

function actionRow(action: PaletteAction): Row {
  return { key: `action:${action.id}`, type: "action", action };
}

/** Extra hit fields a recent resource tab carries, so its star can open it. */
function recentHitExtras(target: WorkspaceTabTarget): Partial<SearchResult> {
  if (target.kind !== "resource") return {};
  return {
    accountId: target.accountId,
    ...(target.pluginId ? { pluginId: target.pluginId } : {}),
    ...(target.resourceTypeId ? { resourceTypeId: target.resourceTypeId } : {}),
  };
}

/**
 * Cmd/Ctrl+K: one keyboard-first way to everything.
 *
 * - **Empty query**: Starred (server-side, per member), Recent (this device),
 *   then suggested actions.
 * - **A query**: the best few matching actions, then hits grouped by kind,
 *   kinds ordered by their best match. Saved objects come from the server's
 *   index (`/search?kinds=`), which only returns what the caller could open;
 *   the host's local results are ranked here with the same matcher.
 * - **`>` prefix**: actions only.
 *
 * The accessibility shape is the spotlight's (`aria-activedescendant`
 * listbox, focus never leaves the input, groups labelled by their headers,
 * status copy outside the listbox); see KNOWLEDGE.md "Accessibility
 * conventions".
 */
export function CommandPalette({
  onClose,
  actions,
  onOpenTarget,
  localResults,
  localLoading,
  canStar,
}: CommandPaletteProps) {
  const gt = useGT();
  const m = useMessages();
  const gtData = useDataString();
  const uid = useId();
  const host = usePaletteHost();
  const client = host?.client ?? null;
  const starred = useStarredItems();
  const recents = useRecents(host?.scope ?? null);

  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<{
    query: string;
    hits: SearchResult[];
    loading: boolean;
    error: string | null;
  }>({ query: "", hits: [], loading: false, error: null });
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const trimmed = query.trimStart();
  const actionMode = trimmed.startsWith(">");
  const q = (actionMode ? trimmed.slice(1) : trimmed).trim();

  // Native modal dialog: top layer, focus containment, Escape via `cancel`,
  // focus restored on close. Land focus on the input explicitly.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // Backdrop dismissal is a mouse convenience; Escape is the keyboard path.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onMouseDown = (e: MouseEvent) => {
      if (e.target === dialog) onClose();
    };
    dialog.addEventListener("mousedown", onMouseDown);
    return () => dialog.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  // The server index, debounced and cancelled when superseded.
  useEffect(() => {
    if (!client || actionMode || !q) {
      setRemote({ query: q, hits: [], loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setRemote((r) => ({ ...r, loading: true, error: null }));
    const timer = setTimeout(() => {
      client
        .search(q, controller.signal)
        .then((hits) => {
          if (!controller.signal.aborted)
            setRemote({ query: q, hits, loading: false, error: null });
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setRemote({ query: q, hits: [], loading: false, error: formatErrorMessage(e) });
        });
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, actionMode, q]);

  const starredKeys = useMemo(() => new Set((starred ?? []).map((s) => starKey(s))), [starred]);

  const groups = useMemo<Group[]>(() => {
    const actionFields = (a: PaletteAction) => ({ primary: a.label, secondary: a.keywords ?? [] });
    if (actionMode) {
      const rows = fuzzyFilter(actions, q, actionFields).map(actionRow);
      return [{ id: "actions", label: gt("Actions"), icon: "action", rows }];
    }

    if (!q) {
      const out: Group[] = [];
      const starredRows = (starred ?? [])
        .slice(0, MAX_STARRED_SHOWN)
        .map((s) => hitRow(s, "starred"));
      if (starredRows.length > 0) {
        out.push({ id: "starred", label: gt("Starred"), icon: "starred", rows: starredRows });
      }
      const recentRows = recents
        .filter((e) => {
          const ref = starRefFromTarget(e.target);
          return !ref || !starredKeys.has(starKey(ref));
        })
        .slice(0, MAX_RECENTS_SHOWN)
        .map(recentRow);
      if (recentRows.length > 0) {
        out.push({ id: "recent", label: gt("Recent"), icon: "recent", rows: recentRows });
      }
      const suggested = actions.filter((a) => a.suggested).map(actionRow);
      if (suggested.length > 0) {
        out.push({ id: "actions", label: gt("Quick actions"), icon: "action", rows: suggested });
      }
      return out;
    }

    const out: { group: Group; score: number }[] = [];
    const actionRows = fuzzyFilter(actions, q, actionFields)
      .slice(0, MAX_ACTIONS_WITH_QUERY)
      .map(actionRow);

    const recentRows = fuzzyFilter(recents, q, (e) => ({ primary: e.title }))
      .slice(0, 3)
      .map(recentRow);

    // Hits: the server's, then the host's local ones, grouped by kind.
    const byKind = new Map<SearchResultKind, SearchResult[]>();
    const seen = new Set<string>();
    const local = localResults
      ? fuzzyFilter(localResults, q, (r) => ({
          primary: r.displayName,
          secondary: [r.subtitle, r.resourceTypeLabel, r.accountName, r.pluginDisplayName],
        })).slice(0, MAX_LOCAL_HITS)
      : [];
    for (const hit of [...(remote.query === q ? remote.hits : []), ...local]) {
      const kind = searchResultKind(hit);
      const key = `${kind}:${hit.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byKind.get(kind) ?? [];
      list.push(hit);
      byKind.set(kind, list);
    }
    for (const [kind, hits] of byKind) {
      const first = hits[0]!;
      out.push({
        group: {
          id: kind,
          label: m(PALETTE_KIND_GROUP_LABELS[kind]),
          icon: kind,
          rows: hits.map((h) => hitRow(h)),
        },
        score: fuzzyScore(q, first.displayName, [first.subtitle, first.resourceTypeLabel]) ?? 0,
      });
    }
    out.sort((a, b) => b.score - a.score);

    const head: Group[] = [];
    if (actionRows.length > 0) {
      head.push({ id: "actions", label: gt("Actions"), icon: "action", rows: actionRows });
    }
    if (recentRows.length > 0) {
      head.push({ id: "recent", label: gt("Recent"), icon: "recent", rows: recentRows });
    }
    return [...head, ...out.map((o) => o.group)];
  }, [actionMode, actions, q, starred, recents, starredKeys, localResults, remote, gt, m]);

  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  // A new result set starts at the top.
  useEffect(() => {
    setActiveIndex(0);
  }, [q, actionMode]);

  const active = rows[Math.min(activeIndex, rows.length - 1)] ?? null;
  const activeIdx = active ? rows.indexOf(active) : -1;

  useEffect(() => {
    if (activeIdx < 0) return;
    listRef.current
      ?.querySelector(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const activate = useCallback(
    (row: Row, newTab: boolean) => {
      onClose();
      if (row.type === "action") {
        row.action.run();
        return;
      }
      if (row.type === "recent") {
        onOpenTarget(row.entry.target, row.entry.title, { newTab });
        return;
      }
      const dest = paletteDestination(row.hit);
      onOpenTarget(dest.target, row.hit.displayName, { newTab });
      if (dest.intent) requestPaletteIntent(dest.intent);
    },
    [onClose, onOpenTarget],
  );

  const starTarget = (row: Row | null): { ref: StarRef; hit: SearchResult } | null => {
    if (!row || row.type === "action" || !row.ref) return null;
    if (canStar && !canStar(row.ref)) return null;
    if (row.type === "hit") return { ref: row.ref, hit: row.hit };
    return {
      ref: row.ref,
      hit: starHit(row.ref, row.entry.title, recentHitExtras(row.entry.target)),
    };
  };

  const activeStar = client ? starTarget(active) : null;
  const activeIsStarred = activeStar ? isStarred(starred, activeStar.ref) : false;

  function toggleActiveStar() {
    if (!host || !activeStar) return;
    const name = activeStar.hit.displayName;
    toggleStar(host, activeStar.ref, activeStar.hit)
      .then((now) => {
        toast.success(now ? gt("Starred {name}", { name }) : gt("Unstarred {name}", { name }));
      })
      .catch((e: unknown) =>
        toast.error(gt("Couldn't update the star: {message}", { message: formatErrorMessage(e) })),
      );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(Math.min(activeIdx + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(Math.max(activeIdx - 1, 0));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setActiveIndex(Math.min(activeIdx + 5, rows.length - 1));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setActiveIndex(Math.max(activeIdx - 5, 0));
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      activate(active, mod);
    } else if (mod && (e.key === "s" || e.key === "S")) {
      // Inside the palette the save shortcut stars; nothing here is a page to save.
      e.preventDefault();
      toggleActiveStar();
    }
  }

  const busy = remote.loading || Boolean(localLoading);
  const mod = modKeyPrefix();

  const emptyCopy = actionMode
    ? q
      ? gt("No actions match “{query}”", { query: q })
      : gt("No actions available")
    : q
      ? busy
        ? gt("Searching…")
        : gt("Nothing matches “{query}”", { query: q })
      : gt("Search reports, dashboards, resources and more. Type > for actions.");

  function rowLabel(row: Row): string {
    if (row.type === "action") return row.action.label;
    if (row.type === "recent") return row.entry.title;
    return row.hit.displayName;
  }

  function rowSubtitle(row: Row): string | null {
    if (row.type === "action") return null;
    if (row.type === "recent") return null;
    const hit = row.hit;
    const kind = searchResultKind(hit);
    if (kind === "resource") {
      return [gtData(hit.resourceTypeLabel), hit.accountName, hit.subtitle]
        .filter(Boolean)
        .join(" · ");
    }
    return hit.subtitle ?? null;
  }

  function rowIcon(row: Row, group: Group) {
    if (row.type === "action") return <PaletteKindIcon kind="action" />;
    if (row.type === "recent") return <PaletteKindIcon kind="recent" />;
    const kind = searchResultKind(row.hit);
    if (kind === "resource" && row.hit.pluginLogoSvg && group.icon !== "starred") {
      return (
        <span
          className="size-3.5 [&>svg]:size-3.5"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: row.hit.pluginLogoSvg }}
        />
      );
    }
    return <PaletteKindIcon kind={kind} />;
  }

  /** The kind badge, where the group heading does not already say it. */
  function rowKindLabel(row: Row, group: Group): string | null {
    if (row.type !== "hit" || group.icon !== "starred") return null;
    return m(PALETTE_KIND_GROUP_LABELS[searchResultKind(row.hit)]);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={gt("Command palette")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="mx-auto mt-[12vh] mb-auto p-0 w-[680px] max-w-[92vw] bg-surface-raised text-inherit border border-border-strong rounded-2xl shadow-2xl overflow-hidden open:flex flex-col backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      style={{ maxHeight: "70vh" }}
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <span aria-hidden="true" className="text-on-surface-muted text-base flex-shrink-0">
          {actionMode ? ">" : "⌕"}
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={gt("Search, or type > for actions…")}
          aria-label={gt("Search everything")}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={activeIdx >= 0 ? `${uid}-opt-${activeIdx}` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent text-on-surface placeholder:text-on-surface-faint text-sm focus:outline-none"
        />
        {busy && (
          <span className="w-3 h-3 border-2 border-on-surface-faint/30 border-t-on-surface-faint rounded-full animate-spin flex-shrink-0" />
        )}
        <kbd className="text-xs text-on-surface-faint flex-shrink-0">esc</kbd>
      </div>

      {/* Result count and search state for screen readers; never inside the listbox. */}
      <div role="status" aria-live="polite" className="sr-only">
        {busy
          ? gt("Searching")
          : rows.length === 1
            ? gt("1 result")
            : gt("{count} results", { count: rows.length })}
      </div>
      {remote.error && (
        <div role="alert" className="px-4 py-2 text-xs text-danger border-b border-border">
          {gt("Search failed: {message}", { message: remote.error })}
        </div>
      )}

      {rows.length === 0 && (
        <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-sm text-on-surface-faint">
          {emptyCopy}
        </div>
      )}

      {/*
        An `aria-activedescendant` listbox: focus stays in the input above,
        which owns the keyboard (arrows, PageUp/Down, Enter, Mod+Enter for a
        new tab, Mod+S to star, Escape through the dialog's cancel). Options
        are not tab stops; their onClick is the mouse half of the pattern, so
        no onKeyDown (it would never fire: an option never holds focus). Each
        group is a `role="group"` named by its heading, so every child of the
        listbox is an option or a group.
      */}
      <div
        ref={listRef}
        id={`${uid}-list`}
        role="listbox"
        aria-label={gt("Results")}
        className={rows.length === 0 ? "hidden" : "overflow-y-auto flex-1 py-1"}
      >
        {groups.map((group) => {
          if (group.rows.length === 0) return null;
          const headerId = `${uid}-group-${group.id}`;
          return (
            <div key={group.id} role="group" aria-labelledby={headerId}>
              <div
                id={headerId}
                className="flex items-center gap-2 px-4 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-on-surface-muted"
              >
                {group.label}
              </div>
              {group.rows.map((row) => {
                const idx = rows.indexOf(row);
                const selected = idx === activeIdx;
                const rowStarred =
                  row.type !== "action" && row.ref ? isStarred(starred, row.ref) : false;
                const subtitle = rowSubtitle(row);
                const kindLabel = rowKindLabel(row, group);
                return (
                  // Mouse half of the activedescendant pattern; see the comment above.
                  <div
                    key={row.key}
                    id={`${uid}-opt-${idx}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    data-idx={idx}
                    onClick={(e) => activate(row, e.metaKey || e.ctrlKey)}
                    onMouseMove={() => {
                      if (!selected) setActiveIndex(idx);
                    }}
                    className={`mx-1.5 flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer ${
                      selected
                        ? "bg-accent-muted text-on-surface"
                        : "text-on-surface-secondary hover:bg-surface-overlay"
                    }`}
                  >
                    <span className="flex size-4 flex-shrink-0 items-center justify-center text-on-surface-muted">
                      {rowIcon(row, group)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm font-medium">{rowLabel(row)}</span>
                      {subtitle && (
                        <span className="block truncate text-xs text-on-surface-muted">
                          {subtitle}
                        </span>
                      )}
                    </span>
                    {kindLabel && (
                      <span className="flex-shrink-0 text-xs text-on-surface-faint">
                        {kindLabel}
                      </span>
                    )}
                    {rowStarred && (
                      <span className="flex-shrink-0 text-warning text-sm leading-none">
                        <span aria-hidden="true">{"★"}</span>
                        <span className="sr-only">{gt("Starred")}</span>
                      </span>
                    )}
                    {selected && (
                      <kbd className="flex-shrink-0 text-xs text-accent" aria-hidden="true">
                        {"↵"}
                      </kbd>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t border-border text-xs text-on-surface-faint">
        <span>{gt("↑↓ navigate")}</span>
        <span>{gt("↵ open")}</span>
        <span>{gt("{mod}↵ new tab", { mod })}</span>
        {client && <span>{gt("{mod}S star", { mod })}</span>}
        <span>{gt("> actions")}</span>
        {activeStar && (
          <button
            type="button"
            aria-pressed={activeIsStarred}
            onClick={() => {
              toggleActiveStar();
              inputRef.current?.focus();
            }}
            className="ml-auto rounded px-2 py-0.5 text-on-surface-secondary hover:bg-surface-overlay hover:text-on-surface"
          >
            {activeIsStarred
              ? gt("Unstar {name}", { name: activeStar.hit.displayName })
              : gt("Star {name}", { name: activeStar.hit.displayName })}
          </button>
        )}
      </div>
    </dialog>
  );
}
