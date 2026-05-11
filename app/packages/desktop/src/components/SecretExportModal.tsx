import { useCallback, useEffect, useState } from "react";
import type { SecretExportTemplate, PluginClient } from "@infrawrench/plugin-base";
import { camelToTitle } from "@infrawrench/plugin-base";
import { getPlugin } from "../plugins/loader";
import { getDb } from "../db/client";
import { invoke } from "../lib/invoke";
import type { DraggableResource } from "../lib/pins";
import { Modal, formatErrorMessage } from "@infrawrench/ui";
import { buildPluginHostServices } from "../lib/sql-drivers";

interface SecretExportModalProps {
  /** Source resource being dragged */
  source: DraggableResource;
  /** Plugin ID of the target (e.g. "kubernetes") */
  targetPluginId: string;
  /** Pre-resolved credentials for the target plugin (e.g. { kubeconfig: "..." }) */
  targetCredentials: Record<string, string>;
  onClose: () => void;
  onCreated: () => void;
}

export function SecretExportModal({
  source,
  targetPluginId,
  targetCredentials,
  onClose,
  onCreated,
}: SecretExportModalProps) {
  const [templates, setTemplates] = useState<SecretExportTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("default");
  const [secretName, setSecretName] = useState("");
  const [editableKeys, setEditableKeys] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetClient, setTargetClient] = useState<PluginClient | null>(null);
  // May differ from source.resourceTypeId for __account__ drops.
  const [effectiveTypeId, setEffectiveTypeId] = useState<string>(source.resourceTypeId);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const sourceLoaded = await getPlugin(source.pluginId);
        if (!sourceLoaded || cancelled) return;

        // Account-level drops: pick the first type with templates.
        let resourceType = sourceLoaded.plugin.resourceTypes.find(
          (t) => t.id === source.resourceTypeId,
        );
        if (
          !resourceType?.secretExportTemplates?.length &&
          source.resourceTypeId === "__account__"
        ) {
          resourceType = sourceLoaded.plugin.resourceTypes.find(
            (t) => (t.secretExportTemplates?.length ?? 0) > 0,
          );
        }
        const tpls = resourceType?.secretExportTemplates ?? [];
        if (tpls.length === 0) {
          setLoadError("This resource type doesn't declare any secret export templates.");
          return;
        }
        if (!cancelled && resourceType) {
          setEffectiveTypeId(resourceType.id);
        }
        if (!cancelled) {
          setTemplates(tpls);
          setSelectedTemplateId(tpls[0]!.id);
          const initial: Record<string, string> = {};
          for (const entry of tpls[0]!.entries) initial[entry.outputKey] = entry.envKey;
          setEditableKeys(initial);
        }

        const baseName = source.displayName
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
        if (!cancelled) setSecretName(baseName || "imported-secret");

        const targetLoaded = await getPlugin(targetPluginId);
        if (!targetLoaded || cancelled) return;
        const targetServices = buildPluginHostServices(
          targetLoaded.plugin.manifest,
          targetCredentials,
        );
        const client = targetLoaded.plugin.createClient(targetCredentials, targetServices);
        if (!cancelled) setTargetClient(client);

        if (client.listNamespacesForImport) {
          try {
            const ns = await client.listNamespacesForImport("");
            if (!cancelled) setNamespaces(ns);
          } catch {
            // best-effort
          }
        }
      } catch (e) {
        if (!cancelled) setLoadError(formatErrorMessage(e));
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [source, targetPluginId, targetCredentials]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  const handleTemplateChange = useCallback(
    (id: string) => {
      setSelectedTemplateId(id);
      const tpl = templates.find((t) => t.id === id);
      if (tpl) {
        const keys: Record<string, string> = {};
        for (const entry of tpl.entries) keys[entry.outputKey] = entry.envKey;
        setEditableKeys(keys);
      }
    },
    [templates],
  );

  const handleCreate = useCallback(async () => {
    if (!selectedTemplate || !targetClient) return;
    setCreating(true);
    setError(null);

    try {
      const db = await getDb();
      const sourceRows = await db.select<{ id: string; plugin_id: string }[]>(
        "SELECT id, plugin_id FROM accounts WHERE id = $1",
        [source.accountId],
      );
      const sourceRow = sourceRows[0];
      if (!sourceRow) throw new Error("Source account not found");

      const sourceCreds = await invoke<Record<string, string>>("account_get_credentials", {
        accountId: sourceRow.id,
      });
      const sourcePlugin = await getPlugin(sourceRow.plugin_id);
      if (!sourcePlugin) throw new Error(`Source plugin "${sourceRow.plugin_id}" not loaded`);

      const sourceClient = sourcePlugin.plugin.createClient(sourceCreds);

      setResolving(true);
      const data: Record<string, string> = {};
      for (const entry of selectedTemplate.entries) {
        const envKey = editableKeys[entry.outputKey] ?? entry.envKey;
        try {
          const value = await sourceClient.resolveOutput(
            effectiveTypeId,
            source.externalId ?? source.id,
            entry.outputKey,
            source.accountId,
          );
          data[envKey] = value;
        } catch {
          const fieldVal = source.fields[entry.outputKey];
          if (fieldVal !== undefined && fieldVal !== null) {
            data[envKey] = String(fieldVal);
          }
        }
      }
      setResolving(false);

      if (!targetClient.importSecret)
        throw new Error("Target plugin doesn't support secret import");
      await targetClient.importSecret("", {
        namespace,
        secretName,
        data,
      });

      onCreated();
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setCreating(false);
      setResolving(false);
    }
  }, [
    selectedTemplate,
    targetClient,
    editableKeys,
    namespace,
    secretName,
    source,
    effectiveTypeId,
    onCreated,
  ]);

  const entryCount = selectedTemplate?.entries.length ?? 0;

  return (
    <Modal onClose={onClose}>
      <div className="w-[min(520px,90vw)] max-h-[80vh] overflow-y-auto rounded-2xl border border-border-strong bg-surface-raised shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-on-surface">Create Kubernetes Secret</h2>
          <button
            onClick={onClose}
            className="text-on-surface-muted hover:text-on-surface-secondary transition-colors text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {loadError ? (
            <p className="text-sm text-red-400">{loadError}</p>
          ) : (
            <>
              {/* Source info */}
              <div className="text-sm text-on-surface-tertiary">
                Exporting secrets from{" "}
                <span className="text-on-surface font-medium">{source.displayName}</span>
              </div>

              {/* Template picker */}
              {templates.length > 1 && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                    Template
                  </label>
                  <div className="space-y-1.5">
                    {templates.map((tpl) => (
                      <label
                        key={tpl.id}
                        className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                          selectedTemplateId === tpl.id
                            ? "border-blue-500 bg-accent-muted"
                            : "border-border-strong hover:border-border-strong"
                        }`}
                      >
                        <input
                          type="radio"
                          name="template"
                          value={tpl.id}
                          checked={selectedTemplateId === tpl.id}
                          onChange={() => handleTemplateChange(tpl.id)}
                          className="mt-0.5 accent-blue-500"
                        />
                        <div>
                          <div className="text-sm font-medium text-on-surface">
                            {tpl.displayName}
                          </div>
                          {tpl.description && (
                            <div className="text-xs text-on-surface-muted mt-0.5">
                              {tpl.description}
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Secret keys preview / editor */}
              {selectedTemplate && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                    Secret Keys ({entryCount})
                  </label>
                  <div className="rounded-lg border border-border-strong divide-y divide-border">
                    {selectedTemplate.entries.map((entry) => (
                      <div key={entry.outputKey} className="flex items-center gap-3 px-3 py-2">
                        <input
                          type="text"
                          value={editableKeys[entry.outputKey] ?? entry.envKey}
                          onChange={(e) =>
                            setEditableKeys((prev) => ({
                              ...prev,
                              [entry.outputKey]: e.target.value,
                            }))
                          }
                          className="flex-1 bg-transparent text-sm font-mono text-on-surface outline-none"
                        />
                        <span className="text-xs text-on-surface-faint">from</span>
                        <span className="text-xs text-on-surface-muted font-mono">
                          {camelToTitle(entry.outputKey)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Namespace */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                  Namespace
                </label>
                {namespaces.length > 0 ? (
                  <select
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    className="w-full rounded-lg border border-border-strong bg-surface-overlay px-3 py-2 text-sm text-on-surface outline-none focus:border-blue-500"
                  >
                    {namespaces.map((ns) => (
                      <option key={ns} value={ns}>
                        {ns}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    placeholder="default"
                    className="w-full rounded-lg border border-border-strong bg-surface-overlay px-3 py-2 text-sm text-on-surface outline-none focus:border-blue-500"
                  />
                )}
              </div>

              {/* Secret name */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                  Secret Name
                </label>
                <input
                  type="text"
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="my-secret"
                  className="w-full rounded-lg border border-border-strong bg-surface-overlay px-3 py-2 text-sm font-mono text-on-surface outline-none focus:border-blue-500"
                />
              </div>

              {/* Error */}
              {error && (
                <p className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loadError && (
          <div className="flex justify-end gap-3 border-t border-border px-5 py-4">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-on-surface-secondary hover:text-on-surface transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={creating || !secretName || !namespace || !selectedTemplate}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-surface-sunken disabled:text-on-surface-muted text-sm font-medium text-white transition-colors flex items-center gap-2"
            >
              {creating && (
                <span className="animate-spin inline-block w-3.5 h-3.5 rounded-full border-2 border-border-strong border-t-white" />
              )}
              {resolving ? "Resolving outputs..." : creating ? "Creating..." : "Create Secret"}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
