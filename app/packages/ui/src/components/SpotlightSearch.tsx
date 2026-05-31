import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpotlightResult[]>([]);
  const [loading, setLoading] = useState(!!loadResults || !!externalLoading);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Document-level ESC handler — local input handler can be swallowed by
  // parent DnD contexts that install their own capture-phase listeners.
  useEffect(() => {
    function onDocKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onDocKey, true);
    return () => document.removeEventListener("keydown", onDocKey, true);
  }, [onClose]);

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
        if (!cancelled) toast.error(`Search failed: ${formatErrorMessage(err)}`);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[640px] max-w-[90vw] bg-surface-raised border border-border-strong rounded-2xl shadow-2xl overflow-hidden flex flex-col"
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
                ? "Jump to resource\u2026"
                : mode === "drop"
                  ? "Search resources to connect\u2026"
                  : "Search resources to add\u2026"
            }
            aria-label="Search"
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
              {"Loading\u2026"}
            </span>
          )}
          {loading && results.length > 0 && (
            <span className="w-3 h-3 border-2 border-on-surface-faint/30 border-t-on-surface-faint rounded-full animate-spin flex-shrink-0" />
          )}
          <kbd className="text-xs text-on-surface-faint flex-shrink-0">esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} id="spotlight-results" role="listbox" className="overflow-y-auto flex-1">
          {results.length === 0 && !loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-on-surface-faint">
              {query ? `No results for \u201c${query}\u201d` : "No resources found"}
            </div>
          ) : (
            Object.entries(grouped).map(([key, items]) => {
              const first = items[0];
              if (!first) return null;
              return (
                <div key={key}>
                  {/* Plugin section header */}
                  <div className="flex items-center gap-2 px-4 py-2 bg-surface/50 sticky top-0">
                    {first.pluginLogoSvg ? (
                      <div
                        className="w-3.5 h-3.5 flex-shrink-0"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: first.pluginLogoSvg }}
                      />
                    ) : null}
                    <span className="text-xs font-medium text-on-surface-muted">
                      {first.pluginDisplayName}
                    </span>
                    <span className="text-xs text-on-surface-faint">
                      &middot; {first.accountName}
                    </span>
                  </div>

                  {items.map((result) => {
                    const globalIdx = results.indexOf(result);
                    const isSelected = globalIdx === selectedIndex;
                    return (
                      <div
                        key={result.id}
                        id={`spotlight-option-${globalIdx}`}
                        role="option"
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
                          {result.resourceTypeLabel}
                        </span>
                        {isSelected && (
                          <kbd className="text-xs text-accent flex-shrink-0">
                            {mode === "navigate"
                              ? "\u21b5 open"
                              : mode === "drop"
                                ? "\u21b5 connect"
                                : "\u21b5 add"}
                          </kbd>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {results.length > 0 && (
          <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-xs text-on-surface-faint">
            <span>&uarr;&darr; navigate</span>
            <span>
              {mode === "navigate"
                ? "\u21b5 open"
                : mode === "drop"
                  ? "\u21b5 connect to current resource"
                  : "\u21b5 pin to dashboard"}
            </span>
            <span>esc close</span>
          </div>
        )}

        {footer}
      </div>
    </div>
  );
}
