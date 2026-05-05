import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SecretVersion,
  SecretVersionMutation,
  SecretVersionsCapability,
} from "@infrawrench/plugin-base";
import { Modal } from "../Modal.js";

interface Props {
  capability: SecretVersionsCapability;
  onList: () => Promise<SecretVersion[]>;
  onAccess: (versionId: string) => Promise<string>;
  onAdd: (value: string) => Promise<SecretVersion>;
  onModify: (versionId: string, action: SecretVersionMutation) => Promise<SecretVersion>;
}

const STATE_COLORS: Record<string, string> = {
  enabled: "bg-emerald-900/30 text-emerald-300 border border-emerald-900/50",
  disabled: "bg-yellow-900/30 text-yellow-300 border border-yellow-900/50",
  destroyed: "bg-red-900/30 text-red-300 border border-red-900/50",
};

function fmt(iso: string | undefined) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function SecretVersionsView({ capability, onList, onAccess, onAdd, onModify }: Props) {
  const [versions, setVersions] = useState<SecretVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ id: string; value: string } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    version: SecretVersion;
    action: SecretVersionMutation;
  } | null>(null);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await onList();
      setVersions(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [onList]);

  useEffect(() => {
    void fetchVersions();
  }, [fetchVersions]);

  const sorted = useMemo(() => {
    if (!versions) return [];
    return [...versions].sort((a, b) => {
      const na = Number(a.id);
      const nb = Number(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
  }, [versions]);

  async function handleAccess(v: SecretVersion) {
    setBusyId(v.id);
    setRevealError(null);
    try {
      const value = await onAccess(v.id);
      setReveal({ id: v.id, value });
    } catch (e) {
      setRevealError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleModify(v: SecretVersion, action: SecretVersionMutation) {
    setBusyId(v.id);
    try {
      await onModify(v.id, action);
      await fetchVersions();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  }

  async function handleAdd() {
    if (!capability.valuelessAdd && !newValue) {
      setAddError("Value is required");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(newValue);
      setNewValue("");
      setShowAdd(false);
      await fetchVersions();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleFile(file: File) {
    const text = await file.text();
    setNewValue(text);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        Loading versions…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          Versions
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void fetchVersions()}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
          >
            Reload
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
          >
            + Add version
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {capability.helpText && (
          <p className="text-xs text-on-surface-muted">{capability.helpText}</p>
        )}

        {error && <div className="text-sm text-red-400 font-mono whitespace-pre-wrap">{error}</div>}

        <div className="overflow-x-auto rounded border border-border bg-surface-overlay/40">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border bg-surface-overlay/60">
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-on-surface-muted w-24">
                  Version
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-on-surface-muted w-32">
                  State
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
                  Created
                </th>
                <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-xs text-on-surface-muted">
                    No versions yet — click “Add version” to create one.
                  </td>
                </tr>
              ) : (
                sorted.map((v) => {
                  const isBusy = busyId === v.id;
                  const destroyed = v.state === "destroyed";
                  return (
                    <tr
                      key={v.id}
                      className="border-b border-border last:border-0 hover:bg-surface-overlay/40 transition-colors"
                    >
                      <td className="px-3 py-2 align-middle">
                        <span className="font-mono text-on-surface">
                          {v.id}
                          {v.isLatest && (
                            <span className="ml-1.5 text-xs text-on-surface-muted">(latest)</span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            STATE_COLORS[v.state] ?? STATE_COLORS["destroyed"]
                          }`}
                        >
                          {v.state}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle text-on-surface-secondary">
                        {fmt(v.createdAt)}
                        {destroyed && v.destroyedAt && (
                          <span className="ml-2 text-xs text-on-surface-muted">
                            destroyed {fmt(v.destroyedAt)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <div className="flex items-center justify-end gap-1.5">
                          {capability.supportsReveal !== false && (
                            <button
                              disabled={destroyed || isBusy}
                              onClick={() => void handleAccess(v)}
                              className="px-2 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors disabled:opacity-40"
                            >
                              Reveal
                            </button>
                          )}
                          {v.state === "enabled" && (
                            <button
                              disabled={isBusy}
                              onClick={() => void handleModify(v, "disable")}
                              className="px-2 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors disabled:opacity-40"
                            >
                              Disable
                            </button>
                          )}
                          {v.state === "disabled" && (
                            <button
                              disabled={isBusy}
                              onClick={() => void handleModify(v, "enable")}
                              className="px-2 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors disabled:opacity-40"
                            >
                              Enable
                            </button>
                          )}
                          <button
                            disabled={destroyed || isBusy}
                            onClick={() => setConfirm({ version: v, action: "destroy" })}
                            className="px-2 py-1 text-xs text-red-300 hover:text-red-100 border border-red-900/60 rounded-md transition-colors disabled:opacity-40"
                          >
                            Destroy
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {reveal && (
        <Modal onClose={() => setReveal(null)}>
          <div className="w-[560px] max-w-[92vw] bg-surface-raised border border-border-strong rounded-lg shadow-2xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-on-surface">Version {reveal.id}</h2>
                <p className="text-xs text-on-surface-muted mt-0.5">
                  Plaintext secret value — close when done.
                </p>
              </div>
              <button
                onClick={() => setReveal(null)}
                className="text-on-surface-faint hover:text-on-surface-tertiary text-sm"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <pre className="max-h-80 overflow-auto rounded border border-border bg-surface-sunken/60 text-xs font-mono p-3 whitespace-pre-wrap break-all text-on-surface">
              {reveal.value || <span className="text-on-surface-muted">(empty)</span>}
            </pre>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => void navigator.clipboard.writeText(reveal.value)}
                className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
              >
                Copy
              </button>
              <button
                onClick={() => setReveal(null)}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}

      {revealError && (
        <Modal onClose={() => setRevealError(null)}>
          <div className="w-[480px] max-w-[92vw] bg-surface-raised border border-border-strong rounded-lg shadow-2xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-on-surface">Cannot reveal</h2>
            <p className="text-xs text-red-400 font-mono whitespace-pre-wrap">{revealError}</p>
            <div className="flex items-center justify-end">
              <button
                onClick={() => setRevealError(null)}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showAdd && (
        <Modal onClose={() => (adding ? undefined : setShowAdd(false))}>
          <div className="w-[560px] max-w-[92vw] bg-surface-raised border border-border-strong rounded-lg shadow-2xl p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-on-surface">Add new version</h2>
              <p className="text-xs text-on-surface-muted mt-0.5">
                The new version becomes the latest enabled version.
              </p>
            </div>
            {!capability.valuelessAdd && (
              <textarea
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="Paste the secret value here…"
                rows={8}
                className="w-full rounded border border-border-strong bg-surface-sunken/60 text-xs font-mono p-3 text-on-surface focus:outline-none focus:border-blue-500"
              />
            )}
            {!capability.valuelessAdd && capability.supportsFileUpload && (
              <label className="flex items-center gap-2 text-xs text-on-surface-tertiary cursor-pointer">
                <span>Or load from file:</span>
                <input
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                  }}
                  className="text-xs"
                />
              </label>
            )}
            {addError && (
              <p className="text-xs text-red-400 font-mono whitespace-pre-wrap">{addError}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                disabled={adding}
                onClick={() => setShowAdd(false)}
                className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                disabled={adding}
                onClick={() => void handleAdd()}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors disabled:opacity-40"
              >
                {adding ? "Adding…" : "Add version"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <div className="w-[460px] max-w-[92vw] bg-surface-raised border border-border-strong rounded-lg shadow-2xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-on-surface">
              Destroy version {confirm.version.id}?
            </h2>
            <p className="text-xs text-on-surface-muted">
              This permanently destroys the version and its data. It cannot be recovered.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleModify(confirm.version, confirm.action)}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-md transition-colors"
              >
                Destroy
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
