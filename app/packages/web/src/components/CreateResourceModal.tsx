import { useState, useEffect, useMemo, useCallback } from "react";
import { Modal, FieldRenderer, evaluateShowWhen, buildDefaultFields, type SshKeyEntry } from "@infrawrench/ui";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import type { CreateResourceConfig } from "@infrawrench/plugin-base";

interface Props {
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  resourceTypeDisplayName: string;
  onClose: () => void;
  onCreated: (resource: { id: string; displayName: string }) => void;
}

export function CreateResourceModal({
  accountId,
  pluginId,
  resourceTypeId,
  resourceTypeDisplayName,
  onClose,
  onCreated,
}: Props) {
  const [config, setConfig] = useState<CreateResourceConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | undefined>();

  useEffect(() => {
    apiGet<{ userId: string }>("/api/auth/me").then((s) => setCurrentUserId(s.userId));
  }, []);
  const [configError, setConfigError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSshKeys = useCallback(
    () => apiGet<SshKeyEntry[]>("/api/ssh-keys"),
    [],
  );
  const generateSshKey = useCallback(
    (name: string) =>
      apiPost<SshKeyEntry & { privateKey?: string }>("/api/ssh-keys", { name }),
    [],
  );
  const deleteSshKey = useCallback(
    (id: string) => apiDelete<void>(`/api/ssh-keys/${id}`),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoadingConfig(true);
        setConfigError(null);
        const cfg = await apiPost<CreateResourceConfig>("/api/resources/create-config", {
          accountId,
          resourceTypeId,
        });
        if (cancelled) return;
        setConfig(cfg);
        setFields(buildDefaultFields(cfg.fields));
      } catch (e) {
        if (!cancelled) setConfigError(e instanceof Error ? e.message : "Failed to load config");
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [accountId, resourceTypeId]);

  const visibleFields = useMemo(() => {
    if (!config) return [];
    return config.fields.filter((f) => evaluateShowWhen(f, fields));
  }, [config, fields]);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const submitFields: Record<string, string> = {};
      for (const f of visibleFields) {
        if (fields[f.key] !== undefined) submitFields[f.key] = fields[f.key]!;
      }
      const created = await apiPost<{ id: string; displayName: string }>("/api/resources/create", {
        accountId,
        pluginId,
        resourceTypeId,
        fields: submitFields,
      });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create resource");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[72vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-100">
            Create {resourceTypeDisplayName}
          </h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 text-xl leading-none">
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5">
          {loadingConfig ? (
            <div className="flex items-center gap-3 text-sm text-gray-500 py-8 justify-center">
              <span className="animate-spin inline-block w-4 h-4 rounded-full border-2 border-gray-600 border-t-gray-300" />
              Fetching available options...
            </div>
          ) : configError ? (
            <p className="text-sm text-red-400">{configError}</p>
          ) : config ? (
            <div className="space-y-6">
              {visibleFields.map((f) => (
                <FieldRenderer
                  key={f.key}
                  field={f}
                  value={fields[f.key] ?? ""}
                  onChange={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))}
                  sshKeyProps={{
                    loadKeys: loadSshKeys,
                    generateKey: generateSshKey,
                    deleteKey: deleteSshKey,
                    ...(currentUserId ? { currentUserId } : {}),
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div className="px-6 py-4 border-t border-gray-800 flex-shrink-0">
          {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={creating || loadingConfig || !!configError}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {creating ? "Creating..." : `Create ${resourceTypeDisplayName}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
