import { useState, useEffect, useCallback } from "react";
import { Modal, formatErrorMessage, toast, SshKeyRadioGroup } from "@infrawrench/ui";
import type { SpotlightResult } from "@infrawrench/ui";
import type { SecretExportTemplate } from "@infrawrench/plugin-base";
import { camelToTitle } from "@infrawrench/plugin-base";
import { apiGet, apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import type { SshKey as FullSshKey } from "@/lib/api-types";

type SshKey = Pick<FullSshKey, "id" | "name" | "ownerName">;

interface ConnectResourceModalProps {
  /** Source resource (from spotlight search) */
  source: SpotlightResult;
  /** Target resource info (the one we're viewing) */
  targetPluginId: string;
  targetAccountId: string;
  targetResourceId: string;
  /** SSH capabilities of the target */
  sshHost?: string | undefined;
  defaultSshUsername?: string | undefined;
  onClose: () => void;
  onConnected: () => void;
}

interface TemplateResponse {
  templates: SecretExportTemplate[];
  effectiveResourceTypeId: string;
  supportsSecretImport: boolean;
  namespaces: string[];
}

type Mode = "secret-export" | "env-deploy";

export function ConnectResourceModal({
  source,
  targetPluginId,
  targetAccountId,
  targetResourceId,
  sshHost,
  defaultSshUsername,
  onClose,
  onConnected,
}: ConnectResourceModalProps) {
  const orgId = useOrgId();

  // Template loading state
  const [templates, setTemplates] = useState<SecretExportTemplate[]>([]);
  const [effectiveTypeId, setEffectiveTypeId] = useState(source.resourceTypeId);
  const [supportsSecretImport, setSupportsSecretImport] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  // Mode selection
  const [mode, setMode] = useState<Mode | null>(null);

  // Secret export state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [editableKeys, setEditableKeys] = useState<Record<string, string>>({});
  const [namespace, setNamespace] = useState("default");
  const [secretName, setSecretName] = useState("");

  // Env deploy state
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [sshUsername, setSshUsername] = useState(defaultSshUsername ?? "root");
  const [format, setFormat] = useState<"dotenv" | "profile">("dotenv");
  const [filePath, setFilePath] = useState("~/.env");
  const [append, setAppend] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingTemplates(true);

    apiPost<TemplateResponse>(`/api/org/${orgId}/connect/templates`, {
      sourcePluginId: source.pluginId,
      sourceResourceTypeId: source.resourceTypeId,
      targetAccountId,
      targetPluginId,
    })
      .then((data) => {
        if (cancelled) return;
        setTemplates(data.templates);
        setEffectiveTypeId(data.effectiveResourceTypeId);
        setSupportsSecretImport(data.supportsSecretImport);
        setNamespaces(data.namespaces);

        if (data.templates.length === 0) {
          setLoadError("This resource type doesn't have any exportable credentials.");
          return;
        }

        setSelectedTemplateId(data.templates[0]!.id);
        const initial: Record<string, string> = {};
        for (const entry of data.templates[0]!.entries) initial[entry.outputKey] = entry.envKey;
        setEditableKeys(initial);

        const baseName = source.displayName
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
        setSecretName(baseName || "imported-secret");

        if (data.supportsSecretImport) {
          setMode("secret-export");
        } else if (sshHost) {
          setMode("env-deploy");
        } else {
          setLoadError(
            "The target resource doesn't support secret import or SSH — cannot connect.",
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(formatErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingTemplates(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, source, targetAccountId, targetPluginId, sshHost]);

  useEffect(() => {
    if (mode !== "env-deploy") return;
    apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`)
      .then((keys) => {
        setSshKeys(keys);
        if (keys.length > 0) setSelectedKeyId(keys[0]!.id);
      })
      .catch((err) => toast.error(`Couldn't load SSH keys: ${formatErrorMessage(err)}`));
  }, [mode, orgId]);

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

  const handleSubmit = useCallback(async () => {
    if (!selectedTemplate) return;
    setSubmitting(true);
    setError(null);

    try {
      if (mode === "secret-export") {
        await apiPost(`/api/org/${orgId}/connect/secret-export`, {
          sourceAccountId: source.accountId,
          sourceResourceId: source.id,
          sourcePluginId: source.pluginId,
          sourceResourceTypeId: effectiveTypeId,
          sourceExternalId: source.externalId,
          targetAccountId,
          targetPluginId,
          templateId: selectedTemplate.id,
          namespace,
          secretName,
          keyOverrides: editableKeys,
        });
      } else if (mode === "env-deploy") {
        if (!selectedKeyId) throw new Error("Select an SSH key");
        await apiPost(`/api/org/${orgId}/connect/env-deploy`, {
          sourceAccountId: source.accountId,
          sourceResourceId: source.id,
          sourcePluginId: source.pluginId,
          sourceResourceTypeId: effectiveTypeId,
          sourceExternalId: source.externalId,
          targetSshHost: sshHost,
          sshKeyId: selectedKeyId,
          sshUsername,
          templateId: selectedTemplate.id,
          keyOverrides: editableKeys,
          format,
          filePath,
          append,
        });
      }
      onConnected();
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }, [
    mode,
    orgId,
    source,
    effectiveTypeId,
    targetAccountId,
    targetPluginId,
    selectedTemplate,
    editableKeys,
    namespace,
    secretName,
    sshHost,
    selectedKeyId,
    sshUsername,
    format,
    filePath,
    append,
    onConnected,
  ]);

  const canSwitchMode = supportsSecretImport && !!sshHost;

  return (
    <Modal onClose={onClose}>
      <div className="w-[min(520px,90vw)] max-h-[80vh] overflow-y-auto rounded-2xl border border-border-strong bg-surface-raised shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-on-surface">
            {mode === "secret-export" ? "Create Kubernetes Secret" : "Deploy Credentials via SSH"}
          </h2>
          <button
            onClick={onClose}
            className="text-on-surface-muted hover:text-on-surface-secondary transition-colors text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {loadingTemplates ? (
            <div className="text-sm text-on-surface-muted animate-pulse">Loading...</div>
          ) : loadError ? (
            <p className="text-sm text-red-400">{loadError}</p>
          ) : (
            <>
              {/* Source info */}
              <div className="text-sm text-on-surface-tertiary">
                Connecting <span className="text-on-surface font-medium">{source.displayName}</span>
                {" to this resource"}
              </div>

              {/* Mode switcher (only when both options available) */}
              {canSwitchMode && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode("secret-export")}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      mode === "secret-export"
                        ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                        : "border-border-strong text-on-surface-muted hover:text-on-surface-secondary"
                    }`}
                  >
                    K8s Secret
                  </button>
                  <button
                    onClick={() => setMode("env-deploy")}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      mode === "env-deploy"
                        ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                        : "border-border-strong text-on-surface-muted hover:text-on-surface-secondary"
                    }`}
                  >
                    SSH Env Deploy
                  </button>
                </div>
              )}

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
                    Keys ({selectedTemplate.entries.length})
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

              {/* Secret export fields */}
              {mode === "secret-export" && (
                <>
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
                </>
              )}

              {/* Env deploy fields */}
              {mode === "env-deploy" && (
                <>
                  {/* SSH key picker */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                      SSH Key
                    </label>
                    {sshKeys.length === 0 ? (
                      <p className="text-xs text-on-surface-faint">
                        No SSH keys found. Go to Settings to add one.
                      </p>
                    ) : (
                      <SshKeyRadioGroup
                        ariaLabel="SSH Key"
                        selectedId={selectedKeyId}
                        onChange={(id) => setSelectedKeyId(id)}
                        keys={sshKeys.map((k) => ({
                          id: k.id,
                          label: k.name,
                          meta: k.ownerName,
                        }))}
                      />
                    )}
                  </div>

                  {/* Username */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                      SSH Username
                    </label>
                    <input
                      type="text"
                      value={sshUsername}
                      onChange={(e) => setSshUsername(e.target.value)}
                      placeholder="root"
                      className="w-full rounded-lg border border-border-strong bg-surface-overlay px-3 py-2 text-sm font-mono text-on-surface outline-none focus:border-blue-500"
                    />
                  </div>

                  {/* Format */}
                  <div className="flex gap-3 items-center">
                    <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                      Format
                    </label>
                    <select
                      value={format}
                      onChange={(e) => setFormat(e.target.value as "dotenv" | "profile")}
                      className="rounded-lg border border-border-strong bg-surface-overlay px-3 py-1.5 text-sm text-on-surface outline-none focus:border-blue-500"
                    >
                      <option value="dotenv">.env (KEY=value)</option>
                      <option value="profile">Shell (export KEY=value)</option>
                    </select>
                  </div>

                  {/* File path + append */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                      File Path
                    </label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={filePath}
                        onChange={(e) => setFilePath(e.target.value)}
                        placeholder="~/.env"
                        className="flex-1 rounded-lg border border-border-strong bg-surface-overlay px-3 py-2 text-sm font-mono text-on-surface outline-none focus:border-blue-500"
                      />
                      <label className="flex items-center gap-1.5 text-xs text-on-surface-tertiary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={append}
                          onChange={(e) => setAppend(e.target.checked)}
                          className="accent-blue-500"
                        />
                        Append
                      </label>
                    </div>
                  </div>
                </>
              )}

              {/* Error */}
              {error && (
                <p className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loadError && !loadingTemplates && (
          <div className="flex justify-end gap-3 border-t border-border px-5 py-4">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-on-surface-secondary hover:text-on-surface transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={
                submitting ||
                !selectedTemplate ||
                (mode === "secret-export" && (!secretName || !namespace)) ||
                (mode === "env-deploy" && (!selectedKeyId || !filePath))
              }
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-surface-sunken disabled:text-on-surface-muted text-sm font-medium text-white transition-colors flex items-center gap-2"
            >
              {submitting && (
                <span className="animate-spin inline-block w-3.5 h-3.5 rounded-full border-2 border-border-strong border-t-white" />
              )}
              {submitting ? "Connecting..." : mode === "secret-export" ? "Create Secret" : "Deploy"}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
