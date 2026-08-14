import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import { groupBy, formatErrorMessage } from "../utils.js";
import { toast } from "./Toast/useToast.js";

export interface SpotlightResult {
  id: string;
  pluginId: string;
  pluginDisplayName: string;
  pluginLogoSvg: string;
  resourceTypeId: string;
  resourceTypeLabel: string;
  accountId: string;
  accountName: string;
  displayName: string;
  subtitle?: string | undefined;
  fields?: Record<string, unknown> | undefined;
  externalId?: string | undefined;
}

export interface SpotlightSearchProps {
  mode: "pin" | "navigate" | "drop";
  onClose: () => void;
  onSelect: (result: SpotlightResult) => void | Promise<void>;
  /**
   * Data loader. Return all results matching the given query.
   * If undefined, the component expects `results` to be provided instead.
   */
  loadResults?: (query: string) => Promise<SpotlightResult[]>;
  /**
   * Pre-loaded results (for desktop's local-first approach).
   * When provided, filtering is done client-side.
   */
  results?: SpotlightResult[] | undefined;
  /** Whether data is currently loading externally. */
  loading?: boolean | undefined;
  /** Group results by this key function. Defaults to `pluginId`. */
  groupKey?: (result: SpotlightResult) => string;
  /** Optional extra content after the footer. */
  footer?: ReactNode;
}

function defaultFilter(results: SpotlightResult[], query: string): SpotlightResult[] {
  if (!query.trim()) return results;
  const q = query.toLowerCase();
  return results.filter(
    (r) =>
      r.displayName.toLowerCase().includes(q) ||
      r.resourceTypeLabel.toLowerCase().includes(q) ||
      r.pluginDisplayName.toLowerCase().includes(q) ||
      r.accountName.toLowerCase().includes(q) ||
      (r.subtitle?.toLowerCase().includes(q) ?? false),
  );
}

export function SpotlightSearch({
  mode,
  onClose,
  onSelect,
  loadResults,
  results: externalResults,
  loading: externalLoading,
  groupKey = (r) => r.pluginId,
  footer,
}: SpotlightSearchProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpotlightResult[]>([]);
  const [loading, setLoading] = useState(!!loadResults || !!externalLoading);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Open as a native modal dialog: the top layer, focus containment, Escape
  // (the cancel event), and focus restoration on close() are all handled by
  // the browser. Land initial focus on the input explicitly — showModal()'s
  // own focusing steps are the fallback.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // API-based loading (web pattern)
  useEffect(() => {
    if (!loadResults) return;
    let cancelled = false;
    setLoading(true);
    loadResults(query)
      .then((data) => {
        if (!cancelled) {
          setResults(data);
          setSelectedIndex(0);
        }
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(gt("Search failed: {message}", { message: formatErrorMessage(err) }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, loadResults]);

  // Client-side filtering (desktop pattern)
  useEffect(() => {
    if (loadResults || !externalResults) return;
    setResults(defaultFilter(externalResults, query));
    setSelectedIndex(0);
  }, [query, externalResults, loadResults]);

  // Sync external loading state
  useEffect(() => {
    if (externalLoading !== undefined) setLoading(externalLoading);
  }, [externalLoading]);

  const handleSelect = useCallback(
    (result: SpotlightResult) => {
      void onSelect(result);
    },
    [onSelect],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      handleSelect(results[selectedIndex]);
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const grouped = groupBy(results, groupKey);

  // Backdrop dismiss is a mouse-only convenience; keyboard users close with
  // Escape (the dialog cancel event). ::backdrop can't take handlers, so
  // mousedowns landing on the dialog element itself (outside the content,
  // i.e. on the backdrop) trigger the dismissal.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (e.target === dialog) onClose();
    };
    dialog.addEventListener("mousedown", handleMouseDown);
    return () => dialog.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={gt("Search")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="mx-auto mt-[15vh] mb-auto p-0 w-[640px] max-w-[90vw] bg-surface-raised text-inherit border border-border-strong rounded-2xl shadow-2xl overflow-hidden open:flex flex-col backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      style={{ maxHeight: "65vh" }}
    >
      {/* Search input */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <span aria-hidden="true" className="text-on-surface-muted text-base flex-shrink-0">
          &#8981;
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            mode === "navigate"
              ? gt("Jump to resource…")
              : mode === "drop"
                ? gt("Search resources to connect…")
                : gt("Search resources to add…")
          }
          aria-label={gt("Search")}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="spotlight-results"
          aria-autocomplete="list"
          aria-activedescendant={
            results[selectedIndex] ? `spotlight-option-${selectedIndex}` : undefined
          }
          className="flex-1 bg-transparent text-on-surface placeholder:text-on-surface-faint text-sm focus:outline-none"
        />
        {loading && results.length === 0 && (
          <span className="text-xs text-on-surface-faint animate-pulse flex-shrink-0">
            {gt("Loading…")}
          </span>
        )}
        {loading && results.length > 0 && (
          <span className="w-3 h-3 border-2 border-on-surface-faint/30 border-t-on-surface-faint rounded-full animate-spin flex-shrink-0">
            <span className="sr-only">{gt("Loading")}</span>
          </span>
        )}
        <kbd className="text-xs text-on-surface-faint flex-shrink-0">esc</kbd>
      </div>

      {/* Screen-reader announcement of the result count */}
      <div role="status" aria-live="polite" className="sr-only">
        {loading
          ? gt("Loading results")
          : results.length === 1
            ? gt("1 result")
            : gt("{count} results", { count: results.length })}
      </div>

      {/*
        Results: an `aria-activedescendant` listbox. Focus stays in the search
        input above, which owns the keyboard path (ArrowUp/Down to move
        `selectedIndex`, Enter to open, Escape via the dialog's cancel event).
        The options are deliberately not tab stops \u2014 `tabIndex={-1}` makes them
        programmatically focusable so assistive tech can reach the selected
        one, and the `onClick` is the mouse half of the same pattern rather
        than the only way in. An onKeyDown on an option would never fire: the
        option never holds focus.

        Each plugin section is a `role="group"` labelled by its own header, so
        every child of the listbox is an `option` or a `group` as ARIA
        requires \u2014 a bare header <div>, or the empty-state copy below, would
        otherwise be announced as a selectable value. The count is already
        announced by the live region above.
      */}
      {results.length === 0 && !loading && (
        <div className="flex flex-1 items-center justify-center py-12 text-sm text-on-surface-faint">
          {query ? gt("No results for “{query}”", { query }) : gt("No resources found")}
        </div>
      )}
      <div
        ref={listRef}
        id="spotlight-results"
        role="listbox"
        aria-label={gt("Results")}
        className={results.length === 0 ? "hidden" : "overflow-y-auto flex-1"}
      >
        {Object.entries(grouped).map(([key, items]) => {
          const first = items[0];
          if (!first) return null;
          const headerId = `spotlight-group-${key}`;
          return (
            <div key={key} role="group" aria-labelledby={headerId}>
              {/* Plugin section header */}
              <div
                id={headerId}
                className="flex items-center gap-2 px-4 py-2 bg-surface/50 sticky top-0"
              >
                {first.pluginLogoSvg ? (
                  <div
                    className="w-3.5 h-3.5 flex-shrink-0"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: first.pluginLogoSvg }}
                  />
                ) : null}
                <span className="text-xs font-medium text-on-surface-muted">
                  {gtData(first.pluginDisplayName)}
                </span>
                {first.accountName && (
                  <span className="text-xs text-on-surface-faint">
                    &middot; {first.accountName}
                  </span>
                )}
              </div>

              {items.map((result) => {
                const globalIdx = results.indexOf(result);
                const isSelected = globalIdx === selectedIndex;
                return (
                  <div
                    key={result.id}
                    id={`spotlight-option-${globalIdx}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    data-idx={globalIdx}
                    onClick={() => handleSelect(result)}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-accent-muted text-on-surface"
                        : "text-on-surface-secondary hover:bg-surface-overlay"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{result.displayName}</div>
                      {result.subtitle && (
                        <div className="text-xs text-on-surface-muted truncate">
                          {result.subtitle}
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-xs flex-shrink-0 ${isSelected ? "text-accent" : "text-on-surface-faint"}`}
                    >
                      {gtData(result.resourceTypeLabel)}
                    </span>
                    {isSelected && (
                      <kbd className="text-xs text-accent flex-shrink-0">
                        {mode === "navigate"
                          ? gt("↵ open")
                          : mode === "drop"
                            ? gt("↵ connect")
                            : gt("↵ add")}
                      </kbd>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {results.length > 0 && (
        <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-xs text-on-surface-faint">
          <span>{gt("↑↓ navigate")}</span>
          <span>
            {mode === "navigate"
              ? gt("↵ open")
              : mode === "drop"
                ? gt("↵ connect to current resource")
                : gt("↵ pin to dashboard")}
          </span>
          <span>{gt("esc close")}</span>
        </div>
      )}

      {footer}
    </dialog>
  );
}
