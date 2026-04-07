import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";
import { buildHostServices } from "../lib/sql-drivers";
import { pinResource, type DraggableResource } from "../lib/pins";

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
  subtitle: string;
  fields: Record<string, unknown>;
  externalId?: string;
}

export type { SearchResult };

interface SpotlightSearchProps {
  dashboardId: string;
  mode: "pin" | "navigate";
  onClose: () => void;
  onPinned: () => void;
  onNavigate: (result: SearchResult) => void;
}

export function SpotlightSearch({ dashboardId, mode, onClose, onPinned, onNavigate }: SpotlightSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const allResultsRef = useRef<SearchResult[]>([]);

  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Load all resources — SQLite immediately, then live from plugins
  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      const db = await getDb();
      const plugins = await loadPlugins();

      const pluginMap = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin]));

      // Build account name map and credentials
      const accountRows = await db.select<{
        id: string;
        plugin_id: string;
        display_name: string;
        encrypted_credentials: string;
        credentials_iv: string;
      }[]>("SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts");

      const accountNames = new Map(accountRows.map((a) => [a.id, a.display_name]));

      // ── Step 1: SQLite cache (instant) ────────────────────────────────────
      const sqliteRows = await db.select<{
        id: string;
        plugin_id: string;
        resource_type_id: string;
        account_id: string;
        display_name: string;
        fields_json: string;
        external_id: string;
      }[]>("SELECT id, plugin_id, resource_type_id, account_id, display_name, fields_json, external_id FROM resources WHERE resource_type_id != '__account__' ORDER BY display_name ASC");

      const fromSqlite: SearchResult[] = sqliteRows.map((r) => {
        const plugin = pluginMap.get(r.plugin_id);
        const fields = (() => { try { return JSON.parse(r.fields_json) as Record<string, unknown>; } catch { return {}; } })();
        const rtDef = plugin?.resourceTypes.find((t) => t.id === r.resource_type_id);
        return {
          id: r.id,
          pluginId: r.plugin_id,
          pluginDisplayName: plugin?.manifest.displayName ?? r.plugin_id,
          pluginLogoSvg: plugin?.manifest.logoSvg ?? "",
          resourceTypeId: r.resource_type_id,
          resourceTypeLabel: rtDef?.displayName ?? r.resource_type_id,
          accountId: r.account_id,
          accountName: accountNames.get(r.account_id) ?? r.account_id,
          displayName: r.display_name,
          subtitle: subtitleFromFields(fields),
          fields,
          externalId: r.external_id,
        };
      });

      if (!cancelled) {
        allResultsRef.current = fromSqlite;
        setResults(filter(fromSqlite, query));
        setLoading(false);
      }

      // ── Step 2: Live from plugins (background refresh) ────────────────────
      const liveResults = new Map<string, SearchResult>(fromSqlite.map((r) => [r.id, r]));

      await Promise.allSettled(accountRows.map(async (account) => {
        const plugin = pluginMap.get(account.plugin_id);
        if (!plugin) return;

        let creds: Record<string, string>;
        try {
          const plaintext = await invoke<string>("decrypt_value", {
            ciphertext: account.encrypted_credentials,
            iv: account.credentials_iv,
          });
          creds = JSON.parse(plaintext) as Record<string, string>;
        } catch { return; }

        const sqlDecl = plugin.manifest.sqlDriver;
        const hostServices = sqlDecl ? buildHostServices(creds[sqlDecl.credentialKey] ?? "") : undefined;
        const client = plugin.createClient(creds, hostServices);

        const topLevelTypes = plugin.resourceTypes.filter((t) => !t.parentTypeId);

        await Promise.allSettled(topLevelTypes.map(async (rt) => {
          const instances = await client.listResources(rt.id, account.id);
          for (const inst of instances) {
            liveResults.set(inst.id, {
              id: inst.id,
              pluginId: plugin.manifest.id,
              pluginDisplayName: plugin.manifest.displayName,
              pluginLogoSvg: plugin.manifest.logoSvg,
              resourceTypeId: rt.id,
              resourceTypeLabel: rt.displayName,
              accountId: account.id,
              accountName: account.display_name,
              displayName: inst.displayName,
              subtitle: subtitleFromFields(inst.fields),
              fields: inst.fields,
              externalId: inst.externalId,
            });
          }
        }));
      }));

      if (!cancelled) {
        const merged = [...liveResults.values()].sort((a, b) =>
          a.displayName.localeCompare(b.displayName),
        );
        allResultsRef.current = merged;
        setResults(filter(merged, query));
      }
    }

    void loadAll();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId]);

  // Filter as query changes
  useEffect(() => {
    setResults(filter(allResultsRef.current, query));
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback(async (result: SearchResult) => {
    if (mode === "navigate") {
      onNavigate(result);
      return;
    }
    const resource: DraggableResource = {
      id: result.id,
      pluginId: result.pluginId,
      resourceTypeId: result.resourceTypeId,
      accountId: result.accountId,
      displayName: result.displayName,
      fields: result.fields,
      externalId: result.externalId,
    };
    const db = await getDb();
    await pinResource(resource, db, dashboardId);
    onPinned();
    onClose();
  }, [mode, dashboardId, onPinned, onClose, onNavigate]);

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
  const grouped = groupBy(results, (r) => r.pluginId);

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
          <span className="text-gray-500 text-base flex-shrink-0">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === "navigate" ? "Jump to resource…" : "Search resources to add…"}
            className="flex-1 bg-transparent text-gray-100 placeholder-gray-600 text-sm focus:outline-none"
          />
          {loading && (
            <span className="text-xs text-gray-600 animate-pulse flex-shrink-0">Loading…</span>
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
            Object.entries(grouped).map(([pluginId, items]) => {
              const first = items[0];
              return (
                <div key={pluginId}>
                  {/* Plugin section header */}
                  <div className="flex items-center gap-2 px-4 py-2 bg-gray-950/50 sticky top-0">
                    {first.pluginLogoSvg ? (
                      <div
                        className="w-3.5 h-3.5 flex-shrink-0"
                        dangerouslySetInnerHTML={{ __html: first.pluginLogoSvg }}
                      />
                    ) : null}
                    <span className="text-xs font-medium text-gray-500">{first.pluginDisplayName}</span>
                    <span className="text-xs text-gray-700">· {first.accountName}</span>
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
                          {result.subtitle && (
                            <div className="text-xs text-gray-500 truncate">{result.subtitle}</div>
                          )}
                        </div>
                        <span className={`text-xs flex-shrink-0 ${isSelected ? "text-blue-400" : "text-gray-600"}`}>
                          {result.resourceTypeLabel}
                        </span>
                        {isSelected && (
                          <kbd className="text-xs text-blue-400 flex-shrink-0">{mode === "navigate" ? "↵ open" : "↵ add"}</kbd>
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
            <span>↑↓ navigate</span>
            <span>{mode === "navigate" ? "↵ open" : "↵ pin to dashboard"}</span>
            <span>esc close</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function subtitleFromFields(fields: Record<string, unknown>): string {
  const host = fields["host"] ?? fields["region"] ?? fields["endpoint"];
  const db = fields["database"] ?? fields["name"];
  if (host && db) return `${String(host)} · ${String(db)}`;
  if (host) return String(host);
  if (db) return String(db);
  return "";
}

function filter(results: SearchResult[], query: string): SearchResult[] {
  if (!query.trim()) return results;
  const q = query.toLowerCase();
  return results.filter(
    (r) =>
      r.displayName.toLowerCase().includes(q) ||
      r.resourceTypeLabel.toLowerCase().includes(q) ||
      r.pluginDisplayName.toLowerCase().includes(q) ||
      r.accountName.toLowerCase().includes(q) ||
      r.subtitle.toLowerCase().includes(q),
  );
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}
