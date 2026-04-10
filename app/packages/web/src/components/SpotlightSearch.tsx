import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { apiGet, apiPost } from "@/lib/api";
import { navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

interface SearchResult {
  id: string;
  pluginId: string;
  pluginDisplayName: string;
  pluginLogoSvg: string;
  resourceTypeId: string;
  resourceTypeLabel: string;
  accountId: string;
  accountName: string;
  displayName: string;
}

interface SpotlightSearchProps {
  dashboardId?: string;
  mode: "pin" | "navigate";
  onClose: () => void;
  onPinned?: () => void;
}

export function SpotlightSearch({ dashboardId, mode, onClose, onPinned }: SpotlightSearchProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetch results from API
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<SearchResult[]>(`/api/search?q=${encodeURIComponent(query)}`)
      .then((data) => {
        if (!cancelled) {
          setResults(data);
          setSelectedIndex(0);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  const handleSelect = useCallback(async (result: SearchResult) => {
    if (mode === "navigate") {
      onClose();
      void navigate({
        to: "/resources/$pluginId/$resourceTypeId/$resourceId",
        params: { pluginId: result.pluginId, resourceTypeId: result.resourceTypeId, resourceId: result.id },
      });
      return;
    }
    if (dashboardId) {
      await apiPost("/api/dashboards/pin", {
        dashboardId,
        resourceId: result.id,
      });
      onPinned?.();
    }
    onClose();
  }, [mode, dashboardId, onClose, onPinned, navigate]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      void handleSelect(results[selectedIndex]);
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Group by plugin
  const grouped = groupBy(results, (r) => `${r.pluginId}:${r.accountName}`);

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
              {query ? `No results for "${query}"` : "No resources found"}
            </div>
          ) : (
            Object.entries(grouped).map(([groupKey, items]) => {
              const first = items[0];
              if (!first) return null;
              return (
                <div key={groupKey}>
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
                        onClick={() => void handleSelect(result)}
                        onMouseEnter={() => setSelectedIndex(globalIdx)}
                        className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                          isSelected ? "bg-blue-600/20 text-gray-100" : "text-gray-300 hover:bg-gray-800"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{result.displayName}</div>
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
      </div>
    </div>
  );
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}
