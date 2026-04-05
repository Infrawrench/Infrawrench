import { useState } from "react";
import { invoke } from "../lib/invoke";
import type { CredentialField } from "@infrawrench/plugin-base";
import { loadPlugins } from "../plugins/loader";
import { getDb } from "../db/client";

interface AddAccountModalProps {
  onClose: () => void;
  onAdded: () => void;
}

type Step = "pick-plugin" | "enter-credentials";

interface PluginOption {
  id: string;
  displayName: string;
  description: string;
  logoSvg: string;
  credentialFields: CredentialField[];
}

export function AddAccountModal({ onClose, onAdded }: AddAccountModalProps) {
  const [step, setStep] = useState<Step>("pick-plugin");
  const [plugins, setPlugins] = useState<PluginOption[] | null>(null);
  const [selected, setSelected] = useState<PluginOption | null>(null);
  const [accountName, setAccountName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load plugins on mount
  if (plugins === null) {
    setPlugins([]); // prevent re-trigger
    loadPlugins().then((loaded) => {
      setPlugins(
        loaded.map((l) => ({
          id: l.plugin.manifest.id,
          displayName: l.plugin.manifest.displayName,
          description: l.plugin.manifest.description,
          logoSvg: l.plugin.manifest.logoSvg,
          credentialFields: l.plugin.manifest.credentialFields,
        })),
      );
    });
  }

  function pickPlugin(p: PluginOption) {
    setSelected(p);
    setAccountName("");
    setFieldValues(Object.fromEntries(p.credentialFields.map((f) => [f.key, f.defaultValue ?? ""])));
    setError(null);
    setStep("enter-credentials");
  }

  async function save() {
    if (!selected) return;
    if (!accountName.trim()) { setError("Account name is required."); return; }
    for (const f of selected.credentialFields) {
      if (!fieldValues[f.key]?.trim() && !f.defaultValue) {
        setError(`${f.label} is required.`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      // Encrypt credentials via Tauri AES-256-GCM command
      const resolvedValues = Object.fromEntries(
        selected.credentialFields.map((f) => [f.key, fieldValues[f.key]?.trim() || f.defaultValue || ""])
      );
      const credJson = JSON.stringify(resolvedValues);
      const { ciphertext, iv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: credJson },
      );

      const db = await getDb();
      const id = crypto.randomUUID();
      await db.execute(
        `INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, selected.id, accountName.trim(), ciphertext, iv],
      );

      onAdded();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">
            {step === "pick-plugin" ? "Add account" : `Add ${selected?.displayName} account`}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-600 hover:text-gray-400 text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-5">
          {step === "pick-plugin" && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 mb-3">Choose a plugin to connect</p>
              {plugins === null || plugins.length === 0 ? (
                <p className="text-xs text-gray-600">Loading plugins…</p>
              ) : (
                plugins.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => pickPlugin(p)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg border border-gray-800 hover:border-gray-600 hover:bg-gray-800 transition-colors text-left"
                  >
                    <div
                      className="w-8 h-8 flex-shrink-0"
                      dangerouslySetInnerHTML={{ __html: p.logoSvg }}
                    />
                    <div>
                      <div className="text-sm font-medium text-gray-200">{p.displayName}</div>
                      <div className="text-xs text-gray-500 line-clamp-1">{p.description}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {step === "enter-credentials" && selected && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Account name</label>
                <input
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder={`My ${selected.displayName} account`}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                />
              </div>

              {selected.credentialFields.map((f) => (
                <div key={f.key}>
                  <label className="block text-xs text-gray-400 mb-1">{f.label}</label>
                  {f.description && (
                    <p className="text-xs text-gray-600 mb-1">{f.description}</p>
                  )}
                  {f.multiline ? (
                    <textarea
                      value={fieldValues[f.key] ?? ""}
                      onChange={(e) => setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      rows={6}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 font-mono resize-none"
                    />
                  ) : (
                    <input
                      type={f.sensitive ? "password" : "text"}
                      value={fieldValues[f.key] ?? ""}
                      onChange={(e) => setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                    />
                  )}
                </div>
              ))}

              {error && <p className="text-xs text-red-400">{error}</p>}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setStep("pick-plugin")}
                  className="flex-1 px-3 py-2 text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  {saving ? "Saving…" : "Add account"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
