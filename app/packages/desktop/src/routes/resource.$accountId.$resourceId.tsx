import { useState, useEffect, useCallback, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import type { ResourceInstance, DetailViewSchema } from "@infrawrench/plugin-base";
import { DetailView, type QueryResult, useUIStore } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { AssignOutputModal } from "../components/AssignOutputModal";
import { getPgSession, setPgSession } from "../lib/pg-session";

export const Route = createFileRoute("/resource/$accountId/$resourceId")({
  component: ResourceDetailPage,
});

interface AccountRow {
  id: string;
  plugin_id: string;
  display_name: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

interface SqliteResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  external_id: string;
  fields_json: string;
}

async function pgQuery(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("pg_query", { connectionString, sql });
}

function ResourceDetailPage() {
  const { accountId, resourceId } = Route.useParams();
  const decodedResourceId = decodeURIComponent(resourceId);

  const [account, setAccount] = useState<AccountRow | null>(null);
  const [resource, setResource] = useState<ResourceInstance | null>(null);
  const [schema, setSchema] = useState<DetailViewSchema | null>(null);
  const [logoSvg, setLogoSvg] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignModalOutput, setAssignModalOutput] = useState<string | null>(null);
  const [pgConnected, setPgConnected] = useState(false);
  const [pgError, setPgError] = useState<string | null>(null);

  const connectionStringRef = useRef("");
  const setAccountConnected = useUIStore((s) => s.setAccountConnected);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError(null);
      setPgError(null);

      try {
        const db = await getDb();
        const session = getPgSession(accountId);

        // ── Fast path ─────────────────────────────────────────────────────
        // If we have a cached connection + the resource is in SQLite, show
        // the page immediately without waiting for listResources or pg queries.
        if (session) {
          connectionStringRef.current = session.connectionString;

          const [accountRows, sqliteRows] = await Promise.all([
            db.select<AccountRow[]>(
              "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
              [accountId],
            ),
            db.select<SqliteResourceRow[]>(
              "SELECT id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json FROM resources WHERE id = $1",
              [decodedResourceId],
            ),
          ]);

          const accountRow = accountRows[0];
          const sqliteRes = sqliteRows[0];

          if (accountRow && sqliteRes) {
            const loaded = await getPlugin(accountRow.plugin_id);
            if (loaded && !cancelled) {
              const now = new Date().toISOString();
              const immediateResource: ResourceInstance = {
                id: sqliteRes.id,
                pluginId: sqliteRes.plugin_id,
                resourceTypeId: sqliteRes.resource_type_id,
                accountId: sqliteRes.account_id,
                displayName: sqliteRes.display_name,
                externalId: sqliteRes.external_id,
                fields: (() => { try { return JSON.parse(sqliteRes.fields_json); } catch { return {}; } })(),
                resolvedOutputs: session.tablesJson ? { __tables__: session.tablesJson } : {},
                secretStates: [],
                createdAt: now,
                updatedAt: now,
              };
              const immediateSchema = loaded.plugin.createClient({ connectionString: session.connectionString }).renderDetail(immediateResource);
              setAccount(accountRow);
              setLogoSvg(loaded.plugin.manifest.logoSvg);
              setResource(immediateResource);
              setSchema({ ...immediateSchema, status: { kind: "status-dot", status: "healthy" } });
              setPgConnected(!!session.tablesJson);
              setAccountConnected(accountId, true);
              setLoading(false); // ← show the page NOW
            }
          }
        } else {
          setLoading(true);
        }

        // ── Full load (runs in background if fast path already showed the page) ──
        const accountRows = await db.select<AccountRow[]>(
          "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
          [accountId],
        );
        const accountRow = accountRows[0];
        if (!accountRow) throw new Error("Account not found");
        if (!cancelled) setAccount(accountRow);

        const plaintext = await invoke<string>("decrypt_value", {
          ciphertext: accountRow.encrypted_credentials,
          iv: accountRow.credentials_iv,
        });
        const credentials = JSON.parse(plaintext) as Record<string, string>;

        const loaded = await getPlugin(accountRow.plugin_id);
        if (!loaded) throw new Error(`Plugin "${accountRow.plugin_id}" not loaded`);
        const { plugin } = loaded;
        if (!cancelled) setLogoSvg(plugin.manifest.logoSvg);

        const client = plugin.createClient(credentials);
        const resourceTypeId = decodedResourceId.split(":")[1] ?? "pg-database";
        const resources = await client.listResources(resourceTypeId, accountId);
        const foundResource = resources.find((r) => r.id === decodedResourceId) ?? resources[0];
        if (!foundResource) throw new Error("Resource not found");

        let enrichedResource: ResourceInstance = foundResource;
        let pgOk = !!session;
        const cs = credentials["connectionString"];

        if (accountRow.plugin_id === "postgres" && cs) {
          connectionStringRef.current = cs;
          try {
            const [tableRows, columnRows, pkRows] = await Promise.all([
              pgQuery(cs, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"),
              pgQuery(cs, "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"),
              pgQuery(cs, `SELECT kcu.table_name, kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
                ORDER BY kcu.table_name, kcu.ordinal_position`),
            ]);

            const colsByTable = new Map<string, { name: string; type: string }[]>();
            for (const col of columnRows as { table_name: string; column_name: string; data_type: string }[]) {
              if (!colsByTable.has(col.table_name)) colsByTable.set(col.table_name, []);
              colsByTable.get(col.table_name)!.push({ name: col.column_name, type: col.data_type });
            }
            const pksByTable = new Map<string, string[]>();
            for (const pk of pkRows as { table_name: string; column_name: string }[]) {
              if (!pksByTable.has(pk.table_name)) pksByTable.set(pk.table_name, []);
              pksByTable.get(pk.table_name)!.push(pk.column_name);
            }

            const tablesJson = JSON.stringify(
              (tableRows as { table_name: string }[]).map((t) => ({
                name: t.table_name,
                columns: colsByTable.get(t.table_name) ?? [],
                pkColumns: pksByTable.get(t.table_name) ?? [],
              })),
            );

            enrichedResource = {
              ...foundResource,
              resolvedOutputs: { ...foundResource.resolvedOutputs, __tables__: tablesJson },
            };

            setPgSession(accountId, { connectionString: cs, tablesJson });

            let pgVersion = "", dbSize = "";
            try {
              const [versionRows, sizeRows] = await Promise.all([
                pgQuery(cs, "SELECT version()"),
                pgQuery(cs, "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
              ]);
              pgVersion = String((versionRows[0] as Record<string, unknown>)?.["version"] ?? "").split(" ").slice(0, 2).join(" ");
              dbSize = String((sizeRows[0] as Record<string, unknown>)?.["size"] ?? "");
            } catch { /* non-critical */ }

            try {
              await db.execute(
                "UPDATE resources SET outputs_json = $1 WHERE id = $2",
                [JSON.stringify({ pgVersion, dbSize, tableCount: tableRows.length }), foundResource.id],
              );
            } catch { /* not pinned */ }

            pgOk = true;
            if (!cancelled) {
              setPgConnected(true);
              setAccountConnected(accountId, true);
            }
          } catch (pgErr) {
            if (!cancelled && !session) setPgError(String(pgErr));
          }
        }

        if (!cancelled) {
          const detailSchema = client.renderDetail(enrichedResource);
          setSchema(pgOk ? { ...detailSchema, status: { kind: "status-dot", status: "healthy" } } : detailSchema);
          setResource(enrichedResource);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [accountId, decodedResourceId]);

  const handleRunQuery = useCallback(async (sql: string): Promise<QueryResult> => {
    const cs = connectionStringRef.current;
    if (!cs) throw new Error("No connection string");
    const start = performance.now();
    const rows = await pgQuery(cs, sql);
    return { rows, durationMs: Math.round(performance.now() - start) };
  }, []);

  const handleExecute = useCallback(async (sql: string, params: unknown[]): Promise<number> => {
    const cs = connectionStringRef.current;
    if (!cs) throw new Error("No connection string");
    return invoke<number>("pg_execute", { connectionString: cs, sql, params });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        Connecting…
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>;
  }

  if (!schema) return null;

  const hasSqlEditor = !!schema.sqlEditor && pgConnected;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {assignModalOutput && account && resource && (
        <AssignOutputModal
          providerResourceId={resource.id}
          providerPluginId={account.plugin_id}
          providerResourceTypeId={resource.resourceTypeId}
          outputKey={assignModalOutput}
          onClose={() => setAssignModalOutput(null)}
        />
      )}

      <DetailView
        schema={schema}
        resourceId={decodedResourceId}
        pluginLogoSvg={logoSvg}
        {...(hasSqlEditor ? { onRunQuery: handleRunQuery, onExecute: handleExecute } : {})}
      />

      {!hasSqlEditor && pgError && (
        <div className="shrink-0 px-4 py-2 border-t border-gray-800 bg-gray-950">
          <span className="text-xs text-red-400 font-mono">SQL connection failed: {pgError}</span>
        </div>
      )}

      {hasSqlEditor && (
        <div className="shrink-0 flex justify-end px-4 py-2 border-t border-gray-800 bg-gray-950">
          <button
            onClick={() => setAssignModalOutput(schema.sqlEditor!.connectionStringOutputKey)}
            className="px-3 py-1 text-xs text-gray-500 hover:text-gray-300 border border-gray-800 hover:border-gray-700 rounded-lg transition-colors"
          >
            Assign connection to…
          </button>
        </div>
      )}
    </div>
  );
}
