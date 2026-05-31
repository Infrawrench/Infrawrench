import { useState, useEffect, useRef, useCallback } from "react";
import { SpotlightSearch as SharedSpotlightSearch, type SpotlightResult } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import type { AccountRow as FullAccountRow } from "../db/rows";
import { loadPlugins } from "../plugins/loader";
import { buildHostServices } from "../lib/sql-drivers";
import { pinResource, type DraggableResource } from "../lib/pins";

type AccountRow = Pick<FullAccountRow, "id" | "plugin_id" | "display_name">;

export type SearchResult = SpotlightResult;

interface SpotlightSearchProps {
  dashboardId?: string;
  mode: "pin" | "navigate" | "drop";
  onClose: () => void;
  onPinned?: () => void;
  onNavigate?: (result: SpotlightResult) => void;
  onDrop?: (resource: DraggableResource) => void;
}

function resultToResource(result: SpotlightResult): DraggableResource {
  return {
    id: result.id,
    pluginId: result.pluginId,
    resourceTypeId: result.resourceTypeId,
    accountId: result.accountId,
    displayName: result.displayName,
    fields: result.fields ?? {},
    externalId: result.externalId,
  };
}

export function SpotlightSearch({
  dashboardId,
  mode,
  onClose,
  onPinned,
  onNavigate,
  onDrop,
}: SpotlightSearchProps) {
  const [allResults, setAllResults] = useState<SpotlightResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const liveResults = new Map<string, SpotlightResult>();

    function flush() {
      if (cancelled) return;
      const sorted = Array.from(liveResults.values()).sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      );
      setAllResults(sorted);
    }

    async function loadAll() {
      let db: Awaited<ReturnType<typeof getDb>>;
      let plugins: Awaited<ReturnType<typeof loadPlugins>>;

      try {
        db = await getDb();
        plugins = await loadPlugins();
      } catch (err) {
        console.error("[spotlight] Failed to init:", err);
        if (!cancelled) setLoading(false);
        return;
      }

      const pluginMap = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin]));

      let accountRows: AccountRow[] = [];

      try {
        accountRows = await db.select<AccountRow[]>(
          "SELECT id, plugin_id, display_name FROM accounts",
        );
      } catch (err) {
        console.error("[spotlight] Failed to query accounts:", err);
        if (!cancelled) setLoading(false);
        return;
      }

      const accountNames = new Map(accountRows.map((a) => [a.id, a.display_name]));

      // First pass: SQLite cache for instant results.
      try {
        const sqliteRows = await db.select<
          {
            id: string;
            plugin_id: string;
            resource_type_id: string;
            account_id: string;
            display_name: string;
            fields_json: string;
            external_id: string;
          }[]
        >(
          "SELECT id, plugin_id, resource_type_id, account_id, display_name, fields_json, external_id FROM resources WHERE resource_type_id != '__account__' ORDER BY display_name ASC",
        );

        for (const r of sqliteRows) {
          const plugin = pluginMap.get(r.plugin_id);
          const fields = (() => {
            try {
              return JSON.parse(r.fields_json) as Record<string, unknown>;
            } catch {
              return {};
            }
          })();
          const rtDef = plugin?.resourceTypes.find((t) => t.id === r.resource_type_id);
          liveResults.set(r.id, {
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
            ...(r.external_id ? { externalId: r.external_id } : {}),
          });
        }

        flush();
      } catch (err) {
        console.error("[spotlight] Failed to query resources cache:", err);
      }

      if (!cancelled && liveResults.size > 0) {
        setLoading(false);
      }

      // Second pass: live results stream in per account.
      if (accountRows.length === 0) {
        if (!cancelled) setLoading(false);
        return;
      }

      let pending = accountRows.length;

      await Promise.allSettled(
        accountRows.map(async (account) => {
          try {
            const plugin = pluginMap.get(account.plugin_id);
            if (!plugin) return;

            let creds: Record<string, string>;
            try {
              creds = await invoke<Record<string, string>>("account_get_credentials", {
                accountId: account.id,
              });
            } catch {
              return;
            }

            const sqlDecl = plugin.manifest.sqlDriver;
            const hostServices = sqlDecl
              ? buildHostServices(sqlDecl.driver, creds[sqlDecl.credentialKey] ?? "")
              : undefined;
            const client = plugin.createClient(creds, hostServices);

            await Promise.allSettled(
              plugin.resourceTypes.map(async (rt) => {
                try {
                  const instances = await client.listResources(rt.id, account.id);
                  if (cancelled) return;
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
                      ...(inst.externalId ? { externalId: inst.externalId } : {}),
                    });
                  }
                  flush();
                } catch {
                  // individual resource type listing failed, continue
                }
              }),
            );
          } finally {
            pending--;
            if (!cancelled && pending <= 0) {
              setLoading(false);
            }
          }
        }),
      );
    }

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [dashboardId]);

  const handleSelect = useCallback(
    async (result: SpotlightResult) => {
      if (mode === "navigate") {
        onNavigate?.(result);
        return;
      }
      if (mode === "drop") {
        onDrop?.(resultToResource(result));
        onClose();
        return;
      }
      if (!dashboardId) return;
      const resource = resultToResource(result);
      const db = await getDb();
      await pinResource(resource, db, dashboardId);
      onPinned?.();
      onClose();
    },
    [mode, dashboardId, onPinned, onClose, onNavigate, onDrop],
  );

  return (
    <SharedSpotlightSearch
      mode={mode}
      onClose={onClose}
      onSelect={handleSelect}
      results={allResults}
      loading={loading}
    />
  );
}

function subtitleFromFields(fields: Record<string, unknown>): string {
  const host = fields["host"] ?? fields["region"] ?? fields["endpoint"];
  const db = fields["database"] ?? fields["name"];
  if (host && db) return `${String(host)} \u00b7 ${String(db)}`;
  if (host) return String(host);
  if (db) return String(db);
  return "";
}
