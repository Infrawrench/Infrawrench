import { useState, useEffect } from "react";
import { Modal } from "./Modal.js";
import { RegionPicker } from "./create-resource/RegionPicker.js";
import { formatErrorMessage } from "../utils.js";

export interface PluginInfo {
  id: string;
  displayName: string;
  logoSvg: string;
  credentialFields: Array<{
    key: string;
    label: string;
    description?: string;
    placeholder?: string;
    sensitive?: boolean;
    multiline?: boolean;
    defaultValue?: string;
    regions?: Array<{ id: string; label: string; location?: string; flag?: string }>;
  }>;
}

interface AddAccountModalProps {
  onClose: () => void;
  onAdded: () => void;
  loadPlugins: () => Promise<PluginInfo[]>;
  saveAccount: (
    pluginId: string,
    displayName: string,
    credentials: Record<string, string>,
  ) => Promise<void>;
}

type Step = "pick-plugin" | "enter-credentials";

export function AddAccountModal({
  onClose,
  onAdded,
  loadPlugins,
  saveAccount,
}: AddAccountModalProps) {
  const [step, setStep] = useState<Step>("pick-plugin");
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const [accountName, setAccountName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    loadPlugins().then(setPlugins).catch(console.error);
  }, [loadPlugins]);

  function pickPlugin(p: PluginInfo) {
    setSelected(p);
    setAccountName("");
    setFieldValues(
      Object.fromEntries(
        p.credentialFields.map((f) => [
          f.key,
          f.defaultValue ?? (f.regions && f.regions.length > 0 ? f.regions[0]!.id : ""),
        ]),
      ),
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
      await saveAccount(selected.id, accountName.trim(), credentials);
      onAdded();
      onClose();
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {step === "pick-plugin" ? "Add account" : `Add ${selected?.displayName} account`}
          </h2>
          <button
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg leading-none"
            aria-label="Close"
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
                aria-label="Search plugins"
                className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong mb-3"
                autoFocus
              />
              {plugins.length === 0 ? (
                <p className="text-xs text-on-surface-faint">Loading plugins...</p>
              ) : (
                <div className="flex flex-wrap gap-2 max-h-[320px] overflow-y-auto">
                  {plugins
                    .filter((p) => p.displayName.toLowerCase().includes(search.toLowerCase()))
                    .sort((a, b) => a.displayName.localeCompare(b.displayName))
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={() => pickPlugin(p)}
                        className="flex items-center gap-2 px-3 py-2 rounded-full border border-border-strong hover:border-border-strong hover:bg-surface-overlay transition-colors"
                      >
                        <div
                          className="w-5 h-5 flex-shrink-0"
                          aria-hidden="true"
                          dangerouslySetInnerHTML={{ __html: p.logoSvg }}
                        />
                        <span className="text-sm font-medium text-on-surface-secondary whitespace-nowrap">
                          {p.displayName}
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}

          {step === "enter-credentials" &&
            selected &&
            (() => {
              const isValid =
                accountName.trim().length > 0 &&
                selected.credentialFields.every(
                  (f) => !!fieldValues[f.key]?.trim() || !!f.defaultValue,
                );
              return (
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="add-account-name"
                      className="block text-xs text-on-surface-tertiary mb-1"
                    >
                      Account name
                    </label>
                    <input
                      id="add-account-name"
                      type="text"
                      value={accountName}
                      onChange={(e) => setAccountName(e.target.value)}
                      placeholder={`My ${selected.displayName} account`}
                      className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
                    />
                  </div>

                  {selected.credentialFields.map((f) => {
                    const fieldId = `add-account-field-${f.key}`;
                    return (
                      <div key={f.key}>
                        <label
                          htmlFor={fieldId}
                          className="block text-xs text-on-surface-tertiary mb-1"
                        >
                          {f.label}
                        </label>
                        {f.description && (
                          <p className="text-xs text-on-surface-faint mb-1">{f.description}</p>
                        )}
                        {f.regions && f.regions.length > 0 ? (
                          <RegionPicker
                            regions={f.regions}
                            value={fieldValues[f.key] ?? ""}
                            onChange={(v) => setFieldValues((cur) => ({ ...cur, [f.key]: v }))}
                          />
                        ) : f.multiline ? (
                          <textarea
                            id={fieldId}
                            value={fieldValues[f.key] ?? ""}
                            onChange={(e) =>
                              setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))
                            }
                            placeholder={f.placeholder}
                            rows={6}
                            className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong font-mono resize-none"
                          />
                        ) : (
                          <input
                            id={fieldId}
                            type={f.sensitive ? "password" : "text"}
                            value={fieldValues[f.key] ?? ""}
                            onChange={(e) =>
                              setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))
                            }
                            placeholder={f.placeholder}
                            className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
                          />
                        )}
                      </div>
                    );
                  })}

                  {error && <p className="text-xs text-red-400">{error}</p>}

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => setStep("pick-plugin")}
                      className="flex-1 px-3 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary border border-border-strong rounded-lg hover:border-border-strong transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => void save()}
                      disabled={saving || !isValid}
                      className="flex-1 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                    >
                      {saving ? "Saving..." : "Add account"}
                    </button>
                  </div>
                </div>
              );
            })()}
        </div>
      </div>
    </Modal>
  );
}
