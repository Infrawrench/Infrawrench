import { useEffect, useState } from "react";
import { Modal } from "./Modal.js";
import { RegionPicker } from "./create-resource/RegionPicker.js";
import { formatErrorMessage } from "../utils.js";
import type { PluginInfo } from "./AddAccountModal.js";

interface EditCredentialsModalProps {
  /** Plugin manifest fragment — same shape used by AddAccountModal. */
  plugin: PluginInfo;
  /** Account display name shown in the header. */
  accountDisplayName: string;
  /** Decrypted current credentials, used to prefill non-sensitive fields. */
  currentCredentials: Record<string, string>;
  /** Persist the new credentials; called with the merged credentials map. */
  onSave: (credentials: Record<string, string>) => Promise<void>;
  onClose: () => void;
  /**
   * Opens a credential field's `helpLink` URL. Desktop routes this through the
   * Electron shell's external-URL handler; web can omit it and fall back to the
   * anchor's native new-tab behavior.
   */
  onOpenExternal?: (url: string) => void;
}

/**
 * Update an existing account's credentials — e.g. rotate an API token after
 * regenerating it upstream, or upgrade the scope on a DigitalOcean PAT.
 *
 * Sensitive fields are rendered empty with a "leave blank to keep current
 * value" placeholder so existing secrets aren't pulled into the DOM unless
 * the user is deliberately changing them. Non-sensitive fields prefill from
 * the current credentials so the user can edit in place.
 */
export function EditCredentialsModal({
  plugin,
  accountDisplayName,
  currentCredentials,
  onSave,
  onClose,
  onOpenExternal,
}: EditCredentialsModalProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFieldValues(
      Object.fromEntries(
        plugin.credentialFields.map((f) => [
          f.key,
          f.sensitive ? "" : (currentCredentials[f.key] ?? ""),
        ]),
      ),
    );
  }, [plugin, currentCredentials]);

  async function save() {
    // Sensitive fields left blank keep their current value; non-sensitive
    // fields submit whatever's in the input (including blank, so the user
    // can clear an optional field).
    const next: Record<string, string> = {};
    for (const f of plugin.credentialFields) {
      const entered = fieldValues[f.key] ?? "";
      if (f.sensitive && !entered) {
        next[f.key] = currentCredentials[f.key] ?? "";
      } else {
        next[f.key] = entered;
      }
    }
    for (const f of plugin.credentialFields) {
      if (f.optional) continue;
      if (!next[f.key]?.trim()) {
        setError(`${f.label} is required.`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(next);
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
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-5 h-5 flex-shrink-0"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: plugin.logoSvg }}
            />
            <h2 className="text-sm font-semibold text-on-surface-secondary truncate">
              Update credentials — {accountDisplayName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg leading-none"
            aria-label="Close"
          >
            &#215;
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-on-surface-faint">
            Rotate the credentials this account uses to talk to {plugin.displayName}. Leave
            sensitive fields blank to keep their current value.
          </p>

          {plugin.credentialFields.map((f) => {
            const fieldId = `edit-account-field-${f.key}`;
            return (
              <div key={f.key}>
                <label htmlFor={fieldId} className="block text-xs text-on-surface-tertiary mb-1">
                  {f.label}
                </label>
                {f.description && (
                  <p className="text-xs text-on-surface-faint mb-1">{f.description}</p>
                )}
                {f.helpLink && (
                  <a
                    href={f.helpLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={
                      onOpenExternal
                        ? (e) => {
                            e.preventDefault();
                            onOpenExternal(f.helpLink!.url);
                          }
                        : undefined
                    }
                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mb-1"
                  >
                    {f.helpLink.label}
                    <span aria-hidden="true">↗</span>
                  </a>
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
                    onChange={(e) => setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.sensitive ? "Leave blank to keep current value" : f.placeholder}
                    rows={6}
                    className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong font-mono resize-none"
                  />
                ) : (
                  <input
                    id={fieldId}
                    type={f.sensitive ? "password" : "text"}
                    value={fieldValues[f.key] ?? ""}
                    onChange={(e) => setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.sensitive ? "Leave blank to keep current value" : f.placeholder}
                    autoComplete="off"
                    className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
                  />
                )}
              </div>
            );
          })}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={saving}
              className="flex-1 px-3 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary border border-border-strong rounded-lg hover:border-border-strong transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="flex-1 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {saving ? "Saving…" : "Save credentials"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
