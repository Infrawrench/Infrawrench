import { useCallback, useEffect, useState } from "react";
import type { SecretExportTemplate } from "@infrawrench/plugin-base";
import { getPlugin } from "../plugins/loader";
import { getDb } from "../db/client";
import { invoke } from "../lib/invoke";
import type { DraggableResource } from "../lib/pins";
import { formatErrorMessage } from "../lib/errors";

interface AccountRow {
  id: string;
  plugin_id: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

interface SecretExportModalProps {
  /** Source resource being dragged */
  source: DraggableResource;
  /** Account ID of the target K8s cluster */
  targetAccountId: string;
  onClose: () => void;
  onCreated: () => void;
}

export function SecretExportModal({ source, targetAccountId, onClose, onCreated }: SecretExportModalProps) {
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

  // Load templates from source plugin + namespaces from target K8s
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Load source plugin to get templates
        const sourceLoaded = await getPlugin(source.pluginId);
        if (!sourceLoaded || cancelled) return;

        const resourceType = sourceLoaded.plugin.resourceTypes.find(
          (t) => t.id === source.resourceTypeId,
        );
        const tpls = resourceType?.secretExportTemplates ?? [];
        if (tpls.length === 0) {
          setLoadError("This resource type doesn't declare any secret export templates.");
          return;
        }
        if (!cancelled) {
          setTemplates(tpls);
          setSelectedTemplateId(tpls[0]!.id);
          // Initialize editable keys from first template
          const initial: Record<string, string> = {};
          for (const entry of tpls[0]!.entries) initial[entry.outputKey] = entry.envKey;
          setEditableKeys(initial);
        }

        // Generate default secret name
        const baseName = source.displayName
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
        if (!cancelled) setSecretName(baseName || "imported-secret");

        // Load target K8s namespaces
        const db = await getDb();
        const targetRows = await db.select<AccountRow[]>(
          "SELECT id, plugin_id, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
          [targetAccountId],
        );
        const targetRow = targetRows[0];
        if (!targetRow || cancelled) return;

        const targetPlaintext = await invoke<string>("decrypt_value", {
          ciphertext: targetRow.encrypted_credentials,
          iv: targetRow.credentials_iv,
        });
        const targetCreds = JSON.parse(targetPlaintext) as Record<string, string>;
        const targetPlugin = await getPlugin(targetRow.plugin_id);
        if (!targetPlugin || cancelled) return;

        const targetClient = targetPlugin.plugin.createClient(targetCreds);
        if (targetClient.listNamespacesForImport) {
          const ns = await targetClient.listNamespacesForImport(targetAccountId);
          if (!cancelled) setNamespaces(ns);
        }
      } catch (e) {
        if (!cancelled) setLoadError(formatErrorMessage(e));
      }
    }

    void init();
    return () => { cancelled = true; };
  }, [source, targetAccountId]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  const handleTemplateChange = useCallback((id: string) => {
    setSelectedTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      const keys: Record<string, string> = {};
      for (const entry of tpl.entries) keys[entry.outputKey] = entry.envKey;
      setEditableKeys(keys);
    }
  }, [templates]);

  const handleCreate = useCallback(async () => {
    if (!selectedTemplate) return;
    setCreating(true);
    setError(null);

    try {
      const db = await getDb();

      // 1. Resolve source outputs
      const sourceRows = await db.select<AccountRow[]>(
        "SELECT id, plugin_id, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
        [source.accountId],
      );
      const sourceRow = sourceRows[0];
      if (!sourceRow) throw new Error("Source account not found");

      const sourcePlaintext = await invoke<string>("decrypt_value", {
        ciphertext: sourceRow.encrypted_credentials,
        iv: sourceRow.credentials_iv,
      });
      const sourceCreds = JSON.parse(sourcePlaintext) as Record<string, string>;
      const sourcePlugin = await getPlugin(sourceRow.plugin_id);
      if (!sourcePlugin) throw new Error(`Source plugin "${sourceRow.plugin_id}" not loaded`);

      const sourceClient = sourcePlugin.plugin.createClient(sourceCreds);

      setResolving(true);
      const data: Record<string, string> = {};
      for (const entry of selectedTemplate.entries) {
        const envKey = editableKeys[entry.outputKey] ?? entry.envKey;
        try {
          // Try resolveOutput first (live API call)
          const value = await sourceClient.resolveOutput(
            source.resourceTypeId,
            source.externalId ?? source.id,
            entry.outputKey,
            source.accountId,
          );
          data[envKey] = value;
        } catch {
          // Fall back to fields
          const fieldVal = source.fields[entry.outputKey];
          if (fieldVal !== undefined && fieldVal !== null) {
            data[envKey] = String(fieldVal);
          }
        }
      }
      setResolving(false);

      // 2. Create K8s secret via target plugin
      const targetRows = await db.select<AccountRow[]>(
        "SELECT id, plugin_id, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
        [targetAccountId],
      );
      const targetRow = targetRows[0];
      if (!targetRow) throw new Error("Target account not found");

      const targetPlaintext = await invoke<string>("decrypt_value", {
        ciphertext: targetRow.encrypted_credentials,
        iv: targetRow.credentials_iv,
      });
      const targetCreds = JSON.parse(targetPlaintext) as Record<string, string>;
      const targetPlugin = await getPlugin(targetRow.plugin_id);
      if (!targetPlugin) throw new Error(`Target plugin "${targetRow.plugin_id}" not loaded`);

      const targetClient = targetPlugin.plugin.createClient(targetCreds);
      if (!targetClient.importSecret) throw new Error("Target plugin doesn't support secret import");

      await targetClient.importSecret(targetAccountId, {
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
  }, [selectedTemplate, editableKeys, namespace, secretName, source, targetAccountId, onCreated]);

  const entryCount = selectedTemplate?.entries.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(520px,90vw)] max-h-[80vh] overflow-y-auto rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <h2 className="text-base font-semibold text-gray-100">
            Create Kubernetes Secret
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
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
              <div className="text-sm text-gray-400">
                Exporting secrets from{" "}
                <span className="text-gray-100 font-medium">{source.displayName}</span>
              </div>

              {/* Template picker */}
              {templates.length > 1 && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Template</label>
                  <div className="space-y-1.5">
                    {templates.map((tpl) => (
                      <label
                        key={tpl.id}
                        className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                          selectedTemplateId === tpl.id
                            ? "border-blue-500 bg-blue-500/10"
                            : "border-gray-700 hover:border-gray-600"
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
                          <div className="text-sm font-medium text-gray-100">{tpl.displayName}</div>
                          {tpl.description && (
                            <div className="text-xs text-gray-500 mt-0.5">{tpl.description}</div>
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
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Secret Keys ({entryCount})
                  </label>
                  <div className="rounded-lg border border-gray-700 divide-y divide-gray-800">
                    {selectedTemplate.entries.map((entry) => (
                      <div key={entry.outputKey} className="flex items-center gap-3 px-3 py-2">
                        <input
                          type="text"
                          value={editableKeys[entry.outputKey] ?? entry.envKey}
                          onChange={(e) =>
                            setEditableKeys((prev) => ({ ...prev, [entry.outputKey]: e.target.value }))
                          }
                          className="flex-1 bg-transparent text-sm font-mono text-gray-100 outline-none"
                        />
                        <span className="text-xs text-gray-600">from</span>
                        <span className="text-xs text-gray-500 font-mono">{entry.outputKey}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Namespace */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Namespace</label>
                {namespaces.length > 0 ? (
                  <select
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
                  >
                    {namespaces.map((ns) => (
                      <option key={ns} value={ns}>{ns}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    placeholder="default"
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
                  />
                )}
              </div>

              {/* Secret name */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Secret Name</label>
                <input
                  type="text"
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="my-secret"
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-mono text-gray-100 outline-none focus:border-blue-500"
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
          <div className="flex justify-end gap-3 border-t border-gray-800 px-5 py-4">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={creating || !secretName || !namespace || !selectedTemplate}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-sm font-medium text-white transition-colors flex items-center gap-2"
            >
              {creating && (
                <span className="animate-spin inline-block w-3.5 h-3.5 rounded-full border-2 border-gray-400 border-t-white" />
              )}
              {resolving ? "Resolving outputs..." : creating ? "Creating..." : "Create Secret"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
