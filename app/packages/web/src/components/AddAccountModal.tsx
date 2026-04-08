"use client";

import { useState, useEffect } from "react";
import { Modal } from "@infrawrench/ui";
import { listPlugins, createAccount, type PluginInfo } from "@/actions/accounts";

interface AddAccountModalProps {
  onClose: () => void;
  onAdded: () => void;
}

type Step = "pick-plugin" | "enter-credentials";

export function AddAccountModal({ onClose, onAdded }: AddAccountModalProps) {
  const [step, setStep] = useState<Step>("pick-plugin");
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const [accountName, setAccountName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    listPlugins().then(setPlugins);
  }, []);

  function pickPlugin(p: PluginInfo) {
    setSelected(p);
    setAccountName("");
    setFieldValues(
      Object.fromEntries(p.credentialFields.map((f) => [f.key, f.defaultValue ?? ""])),
    );
    setError(null);
    setStep("enter-credentials");
  }

  async function save() {
    if (!selected) return;
    if (!accountName.trim()) {
      setError("Account name is required.");
      return;
    }
    for (const f of selected.credentialFields) {
      if (!fieldValues[f.key]?.trim() && !f.defaultValue) {
        setError(`${f.label} is required.`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const credentials = Object.fromEntries(
        selected.credentialFields.map((f) => [
          f.key,
          fieldValues[f.key]?.trim() || f.defaultValue || "",
        ]),
      );
      await createAccount({
        pluginId: selected.id,
        displayName: accountName.trim(),
        credentials,
      });
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create account");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
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
            &#215;
          </button>
        </div>

        <div className="p-5">
          {step === "pick-plugin" && (
            <div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search plugins..."
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 mb-3"
                autoFocus
              />
              {plugins.length === 0 ? (
                <p className="text-xs text-gray-600">Loading plugins...</p>
              ) : (
                <div className="flex flex-wrap gap-2 max-h-[320px] overflow-y-auto">
                  {plugins
                    .filter((p) => p.displayName.toLowerCase().includes(search.toLowerCase()))
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={() => pickPlugin(p)}
                        className="flex items-center gap-2 px-3 py-2 rounded-full border border-gray-700 hover:border-gray-500 hover:bg-gray-800 transition-colors"
                      >
                        <div
                          className="w-5 h-5 flex-shrink-0"
                          dangerouslySetInnerHTML={{ __html: p.logoSvg }}
                        />
                        <span className="text-sm font-medium text-gray-200 whitespace-nowrap">
                          {p.displayName}
                        </span>
                      </button>
                    ))}
                </div>
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
                      onChange={(e) =>
                        setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))
                      }
                      placeholder={f.placeholder}
                      rows={6}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 font-mono resize-none"
                    />
                  ) : (
                    <input
                      type={f.sensitive ? "password" : "text"}
                      value={fieldValues[f.key] ?? ""}
                      onChange={(e) =>
                        setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))
                      }
                      placeholder={f.placeholder}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                    />
                  )}
                </div>
              ))}

              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setStep("pick-plugin")}
                  className="flex-1 px-3 py-2 text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  {saving ? "Saving..." : "Add account"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
