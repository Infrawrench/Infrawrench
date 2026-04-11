import { useState, useEffect, useRef, useCallback } from "react";
import { SpotlightSearch as SharedSpotlightSearch, getListableResourceTypes, type SpotlightResult } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";
import { buildHostServices } from "../lib/sql-drivers";
import { pinResource, type DraggableResource } from "../lib/pins";

export type SearchResult = SpotlightResult;

interface SpotlightSearchProps {
  dashboardId: string;
  mode: "pin" | "navigate";
  onClose: () => void;
  onPinned: () => void;
  onNavigate: (result: SpotlightResult) => void;
}

export function SpotlightSearch({ dashboardId, mode, onClose, onPinned, onNavigate }: SpotlightSearchProps) {
  const [allResults, setAllResults] = useState<SpotlightResult[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef(false);

  // Load all resources — SQLite immediately, then live from plugins
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;

    async function loadAll() {
      const db = await getDb();
      const plugins = await loadPlugins();

      const pluginMap = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin]));

      const accountRows = await db.select<{
        id: string;
        plugin_id: string;
        display_name: string;
        encrypted_credentials: string;
        credentials_iv: string;
      }[]>("SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts");

      const accountNames = new Map(accountRows.map((a) => [a.id, a.display_name]));

      // Step 1: SQLite cache (instant)
      const sqliteRows = await db.select<{
        id: string;
        plugin_id: string;
        resource_type_id: string;
        account_id: string;
        display_name: string;
        fields_json: string;
        external_id: string;
      }[]>("SELECT id, plugin_id, resource_type_id, account_id, display_name, fields_json, external_id FROM resources WHERE resource_type_id != '__account__' ORDER BY display_name ASC");

      const fromSqlite: SpotlightResult[] = sqliteRows.map((r) => {
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
          ...(r.external_id ? { externalId: r.external_id } : {}),
        };
      });

      if (!cancelled) {
        setAllResults(fromSqlite);
        setLoading(false);
      }

      // Step 2: Live from plugins (background refresh)
      const liveResults = new Map<string, SpotlightResult>(fromSqlite.map((r) => [r.id, r]));

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
        const hostServices = sqlDecl
          ? buildHostServices(sqlDecl.driver, creds[sqlDecl.credentialKey] ?? "")
          : undefined;
        const client = plugin.createClient(creds, hostServices);

        const topLevelTypes = getListableResourceTypes(plugin.resourceTypes);

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
              ...(inst.externalId ? { externalId: inst.externalId } : {}),
            });
          }
        }));
      }));

      if (!cancelled) {
        const merged = [...liveResults.values()].sort((a, b) =>
          a.displayName.localeCompare(b.displayName),
        );
        setAllResults(merged);
      }
    }

    void loadAll();
    return () => { cancelled = true; };
  }, [dashboardId]);

  const handleSelect = useCallback(async (result: SpotlightResult) => {
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
      fields: result.fields ?? {},
      externalId: result.externalId,
    };
    const db = await getDb();
    await pinResource(resource, db, dashboardId);
    onPinned();
    onClose();
  }, [mode, dashboardId, onPinned, onClose, onNavigate]);

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
