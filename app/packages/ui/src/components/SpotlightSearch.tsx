import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { groupBy } from "../utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  mode: "pin" | "navigate";
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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Component ────────────────────────────────────────────────────────────────

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
  const [loading, setLoading] = useState(!!loadResults);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
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
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
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
    if (e.key === "Escape") { onClose(); return; }
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
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[640px] max-w-[90vw] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "65vh" }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          <span className="text-gray-500 text-base flex-shrink-0">&#8981;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === "navigate" ? "Jump to resource\u2026" : "Search resources to add\u2026"}
            className="flex-1 bg-transparent text-gray-100 placeholder-gray-600 text-sm focus:outline-none"
          />
          {loading && (
            <span className="text-xs text-gray-600 animate-pulse flex-shrink-0">Loading\u2026</span>
          )}
          <kbd className="text-xs text-gray-700 flex-shrink-0">esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto flex-1">
          {results.length === 0 && !loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-gray-600">
              {query ? `No results for \u201c${query}\u201d` : "No resources found"}
            </div>
          ) : (
            Object.entries(grouped).map(([key, items]) => {
              const first = items[0];
              if (!first) return null;
              return (
                <div key={key}>
                  {/* Plugin section header */}
                  <div className="flex items-center gap-2 px-4 py-2 bg-gray-950/50 sticky top-0">
                    {first.pluginLogoSvg ? (
                      <div
                        className="w-3.5 h-3.5 flex-shrink-0"
                        dangerouslySetInnerHTML={{ __html: first.pluginLogoSvg }}
                      />
                    ) : null}
                    <span className="text-xs font-medium text-gray-500">{first.pluginDisplayName}</span>
                    <span className="text-xs text-gray-700">&middot; {first.accountName}</span>
                  </div>

                  {items.map((result) => {
                    const globalIdx = results.indexOf(result);
                    const isSelected = globalIdx === selectedIndex;
                    return (
                      <div
                        key={result.id}
                        data-idx={globalIdx}
                        onClick={() => handleSelect(result)}
                        onMouseEnter={() => setSelectedIndex(globalIdx)}
                        className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                          isSelected ? "bg-blue-600/20 text-gray-100" : "text-gray-300 hover:bg-gray-800"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{result.displayName}</div>
                          {result.subtitle && (
                            <div className="text-xs text-gray-500 truncate">{result.subtitle}</div>
                          )}
                        </div>
                        <span className={`text-xs flex-shrink-0 ${isSelected ? "text-blue-400" : "text-gray-600"}`}>
                          {result.resourceTypeLabel}
                        </span>
                        {isSelected && (
                          <kbd className="text-xs text-blue-400 flex-shrink-0">{mode === "navigate" ? "\u21b5 open" : "\u21b5 add"}</kbd>
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
          <div className="px-4 py-2 border-t border-gray-800 flex items-center gap-4 text-xs text-gray-700">
            <span>&uarr;&darr; navigate</span>
            <span>{mode === "navigate" ? "\u21b5 open" : "\u21b5 pin to dashboard"}</span>
            <span>esc close</span>
          </div>
        )}

        {footer}
      </div>
    </div>
  );
}
