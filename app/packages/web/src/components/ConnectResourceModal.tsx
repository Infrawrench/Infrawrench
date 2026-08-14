import { useState, useEffect, useCallback } from "react";
import { T, Var, useGT } from "gt-react";
import { Modal, formatErrorMessage, toast, SshKeyRadioGroup, useDataString } from "@infrawrench/ui";
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
  const gt = useGT();
  const gtData = useDataString();
  const orgId = useOrgId();

  const templatesKey = `${orgId}/${source.pluginId}/${source.resourceTypeId}/${targetAccountId}/${targetPluginId}`;

  // Template loading state — folded into a keyed store so it derives during
  // render instead of resetting synchronously when the request identity changes.
  const [templateStore, setTemplateStore] = useState<{
    forKey: string;
    loading: boolean;
    templates: SecretExportTemplate[];
    effectiveTypeId: string;
    supportsSecretImport: boolean;
    namespaces: string[];
    loadError: string | null;
  }>({
    forKey: "",
    loading: true,
    templates: [],
    effectiveTypeId: source.resourceTypeId,
    supportsSecretImport: false,
    namespaces: [],
    loadError: null,
  });

  const matchesKey = templateStore.forKey === templatesKey;
  const loadingTemplates = !matchesKey || templateStore.loading;
  const templates = matchesKey ? templateStore.templates : [];
  const effectiveTypeId = matchesKey ? templateStore.effectiveTypeId : source.resourceTypeId;
  const supportsSecretImport = matchesKey ? templateStore.supportsSecretImport : false;
  const namespaces = matchesKey ? templateStore.namespaces : [];
  const loadError = matchesKey ? templateStore.loadError : null;

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

    apiPost<TemplateResponse>(`/api/org/${orgId}/connect/templates`, {
      sourcePluginId: source.pluginId,
      sourceResourceTypeId: source.resourceTypeId,
      targetAccountId,
      targetPluginId,
    })
      .then((data) => {
        if (cancelled) return;

        const base = {
          forKey: templatesKey,
          loading: false,
          templates: data.templates,
          effectiveTypeId: data.effectiveResourceTypeId,
          supportsSecretImport: data.supportsSecretImport,
          namespaces: data.namespaces,
        };

        if (data.templates.length === 0) {
          setTemplateStore({
            ...base,
            loadError: gt("This resource type doesn't have any exportable credentials."),
          });
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
          setTemplateStore({ ...base, loadError: null });
        } else if (sshHost) {
          setMode("env-deploy");
          setTemplateStore({ ...base, loadError: null });
        } else {
          setTemplateStore({
            ...base,
            loadError: gt(
              "The target resource doesn't support secret import or SSH — cannot connect.",
            ),
          });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setTemplateStore({
          forKey: templatesKey,
          loading: false,
          templates: [],
          effectiveTypeId: source.resourceTypeId,
          supportsSecretImport: false,
          namespaces: [],
          loadError: formatErrorMessage(e),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, source, targetAccountId, targetPluginId, sshHost, templatesKey, gt]);

  useEffect(() => {
    if (mode !== "env-deploy") return;
    apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`)
      .then((keys) => {
        setSshKeys(keys);
        if (keys.length > 0) setSelectedKeyId(keys[0]!.id);
      })
      .catch((err) =>
        toast.error(gt("Couldn't load SSH keys: {error}", { error: formatErrorMessage(err) })),
      );
  }, [mode, orgId, gt]);

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
        if (!selectedKeyId) throw new Error(gt("Select an SSH key"));
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
    gt,
  ]);

  const canSwitchMode = supportsSecretImport && !!sshHost;
  const modalTitle =
    mode === "secret-export" ? gt("Create Kubernetes Secret") : gt("Deploy Credentials via SSH");

  return (
    <Modal onClose={onClose} ariaLabel={modalTitle}>
      <div className="w-[min(520px,90vw)] max-h-[80vh] overflow-y-auto rounded-2xl border border-border-strong bg-surface-raised shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-on-surface">{modalTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={gt("Close {title}", { title: modalTitle })}
            title={gt("Close {title}", { title: modalTitle })}
            className="text-on-surface-muted hover:text-on-surface-secondary transition-colors text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {loadingTemplates ? (
            <div className="text-sm text-on-surface-muted animate-pulse">{gt("Loading…")}</div>
          ) : loadError ? (
            <p className="text-sm text-danger">{loadError}</p>
          ) : (
            <>
              {/* Source info */}
              <div className="text-sm text-on-surface-tertiary">
                <T>
                  Connecting{" "}
                  <Var>
                    <span className="text-on-surface font-medium">{source.displayName}</span>
                  </Var>
                  {" to this resource"}
                </T>
              </div>

              {/* Mode switcher (only when both options available) */}
              {canSwitchMode && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setMode("secret-export")}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      mode === "secret-export"
                        ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                        : "border-border-strong text-on-surface-muted hover:text-on-surface-secondary"
                    }`}
                  >
                    {gt("K8s Secret")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("env-deploy")}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      mode === "env-deploy"
                        ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                        : "border-border-strong text-on-surface-muted hover:text-on-surface-secondary"
                    }`}
                  >
                    {gt("SSH Env Deploy")}
                  </button>
                </div>
              )}

              {/* Template picker */}
              {templates.length > 1 && (
                <div className="space-y-2">
                  <span className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                    {gt("Template")}
                  </span>
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
                          aria-label={gtData(tpl.displayName)}
                        />
                        <div>
                          <div className="text-sm font-medium text-on-surface">
                            {gtData(tpl.displayName)}
                          </div>
                          {tpl.description && (
                            <div className="text-xs text-on-surface-muted mt-0.5">
                              {gtData(tpl.description)}
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
                  <span className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                    {gt("Keys ({count})", { count: selectedTemplate.entries.length })}
                  </span>
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
                          aria-label={gt("Environment variable key for {label}", {
                            label: gtData(camelToTitle(entry.outputKey)),
                          })}
                        />
                        <span className="text-xs text-on-surface-faint">{gt("from")}</span>
                        <span className="text-xs text-on-surface-muted font-mono">
                          {gtData(camelToTitle(entry.outputKey))}
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
                    <span className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                      {gt("Namespace")}
                    </span>
                    {namespaces.length > 0 ? (
                      <select
                        value={namespace}
                        onChange={(e) => setNamespace(e.target.value)}
                        className="w-full rounded-lg border border-border-strong bg-surface-overlay px-3 py-2 text-sm text-on-surface outline-none focus:border-blue-500"
                        aria-label={gt("Namespace")}
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
                        aria-label={gt("Namespace")}
                      />
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label
                      id="connect-resource-secret-name-label"
                      htmlFor="connect-resource-secret-name"
                      className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider"
                    >
                      {gt("Secret Name")}
                    </label>
                    <input
                      id="connect-resource-secret-name"
                      aria-labelledby="connect-resource-secret-name-label"
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
                    <span className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider">
                      {gt("SSH Key")}
                    </span>
                    {sshKeys.length === 0 ? (
                      <p className="text-xs text-on-surface-faint">
                        {gt("No SSH keys found. Go to Settings to add one.")}
                      </p>
                    ) : (
                      <SshKeyRadioGroup
                        ariaLabel={gt("SSH Key")}
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
                    <label
                      id="connect-resource-ssh-username-label"
                      htmlFor="connect-resource-ssh-username"
                      className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider"
                    >
                      {gt("SSH Username")}
                    </label>
                    <input
                      id="connect-resource-ssh-username"
                      aria-labelledby="connect-resource-ssh-username-label"
                      type="text"
                      value={sshUsername}
                      onChange={(e) => setSshUsername(e.target.value)}
                      placeholder="root"
                      className="w-full rounded-lg border border-border-strong bg-surface-overlay px-3 py-2 text-sm font-mono text-on-surface outline-none focus:border-blue-500"
                    />
                  </div>

                  {/* Format */}
                  <div className="flex gap-3 items-center">
                    <label
                      htmlFor="connect-resource-format"
                      className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider"
                    >
                      {gt("Format")}
                    </label>
                    <select
                      id="connect-resource-format"
                      value={format}
                      onChange={(e) => setFormat(e.target.value as "dotenv" | "profile")}
                      className="rounded-lg border border-border-strong bg-surface-overlay px-3 py-1.5 text-sm text-on-surface outline-none focus:border-blue-500"
                    >
                      <option value="dotenv">{gt(".env (KEY=value)")}</option>
                      <option value="profile">{gt("Shell (export KEY=value)")}</option>
                    </select>
                  </div>

                  {/* File path + append */}
                  <div className="space-y-1.5">
                    <label
                      id="connect-resource-file-path-label"
                      htmlFor="connect-resource-file-path"
                      className="text-xs font-medium text-on-surface-tertiary uppercase tracking-wider"
                    >
                      {gt("File Path")}
                    </label>
                    <div className="flex gap-2 items-center">
                      <input
                        id="connect-resource-file-path"
                        aria-labelledby="connect-resource-file-path-label"
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
                          aria-label={gt("Append")}
                        />
                        {gt("Append")}
                      </label>
                    </div>
                  </div>
                </>
              )}

              {/* Error */}
              {error && (
                <p className="text-sm text-danger bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loadError && !loadingTemplates && (
          <div className="flex justify-end gap-3 border-t border-border px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-on-surface-secondary hover:text-on-surface transition-colors"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
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
                <span className="animate-spin inline-block size-3.5 rounded-full border-2 border-border-strong border-t-white" />
              )}
              {submitting
                ? gt("Connecting...")
                : mode === "secret-export"
                  ? gt("Create Secret")
                  : gt("Deploy")}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
