import { useState, useEffect, useCallback } from "react";
import { invoke } from "../lib/invoke";
import { getPlugin } from "../plugins/loader";
import { sshExecCommand } from "../lib/ssh-tunnel";
import { Modal, formatErrorMessage } from "@infrawrench/ui";
import { ErrorNotice } from "./ErrorNotice";
import { SshKeyPicker } from "./SshKeyPicker";
import type { DraggableResource } from "../lib/pins";
import type { SecretExportTemplate } from "@infrawrench/plugin-base";
import { buildPluginHostServices } from "../lib/sql-drivers";

type Format = "dotenv" | "profile";

interface SshEnvDeployModalProps {
  source: DraggableResource;
  sshHost: string;
  onClose: () => void;
  onDeployed: () => void;
}

export function SshEnvDeployModal({
  source,
  sshHost,
  onClose,
  onDeployed,
}: SshEnvDeployModalProps) {
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [privateKey, setPrivateKey] = useState("");

  const [templates, setTemplates] = useState<SecretExportTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [editableKeys, setEditableKeys] = useState<Record<string, string>>({});
  const [effectiveTypeId, setEffectiveTypeId] = useState(source.resourceTypeId);

  const [format, setFormat] = useState<Format>("dotenv");
  const [filePath, setFilePath] = useState("~/.env");
  const [append, setAppend] = useState(true);

  const [deploying, setDeploying] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load templates from source plugin
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const loaded = await getPlugin(source.pluginId);
        if (!loaded || cancelled) return;

        let resourceType = loaded.plugin.resourceTypes.find((t) => t.id === source.resourceTypeId);
        if (
          !resourceType?.secretExportTemplates?.length &&
          source.resourceTypeId === "__account__"
        ) {
          resourceType = loaded.plugin.resourceTypes.find(
            (t) => (t.secretExportTemplates?.length ?? 0) > 0,
          );
        }
        const tpls = resourceType?.secretExportTemplates ?? [];
        if (tpls.length === 0) {
          if (!cancelled)
            setLoadError("This resource type doesn't have any exportable credentials.");
          return;
        }
        if (!cancelled && resourceType) setEffectiveTypeId(resourceType.id);
        if (!cancelled) {
          setTemplates(tpls);
          setSelectedTemplateId(tpls[0]!.id);
          const initial: Record<string, string> = {};
          for (const entry of tpls[0]!.entries) initial[entry.outputKey] = entry.envKey;
          setEditableKeys(initial);
        }
      } catch (e) {
        if (!cancelled) setLoadError(formatErrorMessage(e));
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [source]);

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

  async function handleDeploy() {
    if (!selectedTemplate || !privateKey.trim()) return;
    setDeploying(true);
    setResolving(true);
    setError(null);

    try {
      const sourceLoaded = await getPlugin(source.pluginId);
      if (!sourceLoaded) throw new Error(`Plugin "${source.pluginId}" not loaded`);

      const { getDb } = await import("../db/client");
      const db = await getDb();
      const rows = await db.select<{ encrypted_credentials: string; credentials_iv: string }[]>(
        "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
        [source.accountId],
      );
      if (!rows[0]) throw new Error("Source account not found");

      const plaintext = await invoke<string>("decrypt_value", {
        ciphertext: rows[0].encrypted_credentials,
        iv: rows[0].credentials_iv,
      });
      const sourceCreds = JSON.parse(plaintext) as Record<string, string>;
      const sourceServices = buildPluginHostServices(sourceLoaded.plugin.manifest, sourceCreds);
      const sourceClient = sourceLoaded.plugin.createClient(sourceCreds, sourceServices);

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

      let content: string;
      if (format === "dotenv") {
        content =
          Object.entries(data)
            .map(([k, v]) => `${k}=${shellQuote(v)}`)
            .join("\n") + "\n";
      } else {
        content =
          Object.entries(data)
            .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
            .join("\n") + "\n";
      }

      const sshConfig = { sshHost, sshPort, sshUser, privateKey: privateKey.trim() };
      const operator = append ? ">>" : ">";
      const expandedPath = filePath.startsWith("~/") ? `$HOME/${filePath.slice(2)}` : filePath;

      // Use printf to avoid heredoc issues over SSH
      const escapedContent = content.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
      const cmd = `printf '%s' '${escapedContent}' ${operator} ${expandedPath}`;

      const result = await sshExecCommand(sshConfig, cmd);
      if (result.code !== 0) {
        throw new Error(`Failed to write to ${filePath}: ${result.stderr || result.stdout}`);
      }

      onDeployed();
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setDeploying(false);
      setResolving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[520px] max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-gray-800">
          <h2 className="text-base font-semibold text-gray-100">Deploy credentials to VM</h2>
          <p className="text-xs text-gray-500 mt-1">
            <span className="text-gray-300 font-medium">{source.displayName}</span> →{" "}
            <span className="text-gray-300 font-mono">{sshHost}</span>
          </p>
        </div>

        <div className="p-6 space-y-4">
          {loadError ? (
            <p className="text-sm text-red-400">{loadError}</p>
          ) : (
            <>
              <SshKeyPicker
                username={sshUser}
                onUsernameChange={setSshUser}
                onKeyResolved={setPrivateKey}
              />

              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-500 w-20 shrink-0">SSH Port</label>
                <input
                  type="number"
                  value={sshPort}
                  onChange={(e) => setSshPort(Number(e.target.value))}
                  className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
                />
              </div>

              {/* Template picker */}
              {templates.length > 1 && (
                <div className="space-y-2">
                  <label className="text-xs text-gray-500">Template</label>
                  <div className="space-y-1">
                    {templates.map((tpl) => (
                      <button
                        key={tpl.id}
                        onClick={() => handleTemplateChange(tpl.id)}
                        className={`w-full text-left rounded-lg border p-2 text-xs transition-colors ${
                          selectedTemplateId === tpl.id
                            ? "border-blue-500 bg-blue-500/10 text-blue-300"
                            : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                        }`}
                      >
                        <div className="font-medium">{tpl.displayName}</div>
                        {tpl.description && (
                          <div className="text-gray-600 mt-0.5">{tpl.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Env keys preview */}
              {selectedTemplate && (
                <div className="space-y-2">
                  <label className="text-xs text-gray-500">
                    Variables ({selectedTemplate.entries.length})
                  </label>
                  <div className="rounded-lg border border-gray-700 divide-y divide-gray-800">
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
                          className="flex-1 bg-transparent text-sm font-mono text-gray-100 outline-none"
                        />
                        <span className="text-xs text-gray-600">from</span>
                        <span className="text-xs text-gray-500 font-mono">{entry.outputKey}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Format */}
              <div className="space-y-2">
                <label className="text-xs text-gray-500">Format</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setFormat("dotenv");
                      if (filePath === "~/.profile") setFilePath("~/.env");
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs border transition-colors ${
                      format === "dotenv"
                        ? "border-blue-500 bg-blue-500/10 text-blue-300"
                        : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    <div className="font-medium">.env</div>
                    <div className="text-gray-600 mt-0.5">KEY=value</div>
                  </button>
                  <button
                    onClick={() => {
                      setFormat("profile");
                      if (filePath === "~/.env") setFilePath("~/.profile");
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs border transition-colors ${
                      format === "profile"
                        ? "border-blue-500 bg-blue-500/10 text-blue-300"
                        : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    <div className="font-medium">Shell profile</div>
                    <div className="text-gray-600 mt-0.5">export KEY=value</div>
                  </button>
                </div>
              </div>

              {/* File path */}
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-500 w-20 shrink-0">File path</label>
                <input
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
                  spellCheck={false}
                />
              </div>

              {/* Append toggle */}
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-500 w-20 shrink-0">Mode</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setAppend(true)}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                      append
                        ? "border-blue-500 bg-blue-500/10 text-blue-300"
                        : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    Append
                  </button>
                  <button
                    onClick={() => setAppend(false)}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                      !append
                        ? "border-blue-500 bg-blue-500/10 text-blue-300"
                        : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    Overwrite
                  </button>
                </div>
              </div>

              {error && (
                <ErrorNotice
                  message={error}
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
                  textClassName="text-xs text-red-400"
                />
              )}
            </>
          )}
        </div>

        {!loadError && (
          <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
            <button
              onClick={onClose}
              disabled={deploying}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleDeploy()}
              disabled={deploying || !privateKey.trim() || !selectedTemplate || !filePath.trim()}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {resolving ? "Resolving..." : deploying ? "Deploying..." : "Deploy"}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
