import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KvBrowserCapability, KvKeyEntry, KvListResult } from "@infrawrench/plugin-base";
import { Modal } from "../Modal.js";

export interface KvBrowserListParams {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

interface Props {
  capability: KvBrowserCapability;
  onListKeys: (params: KvBrowserListParams) => Promise<KvListResult>;
  onGetValue: (key: string) => Promise<string>;
  onPutValue: (key: string, value: string) => Promise<void>;
  onDeleteKey: (key: string) => Promise<void>;
}

/**
 * Returns true when a string contains the kind of control characters / NULs
 * that suggest the underlying value isn't actually UTF-8 text. We don't try
 * to be a binary editor — when this fires we surface a banner and disable
 * the save button so users don't accidentally corrupt the value.
 */
function looksBinary(value: string): boolean {
  // NUL byte or many control chars in the first slice → almost certainly binary.
  if (value.includes("\0")) return true;
  const sample = value.slice(0, 4096);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow tab, LF, CR.
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) bad++;
  }
  return bad > sample.length * 0.05;
}

export function KvBrowserView({
  capability,
  onListKeys,
  onGetValue,
  onPutValue,
  onDeleteKey,
}: Props) {
  const [prefix, setPrefix] = useState("");
  const [items, setItems] = useState<KvKeyEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [value, setValue] = useState<string>("");
  const [originalValue, setOriginalValue] = useState<string>("");
  const [valueLoading, setValueLoading] = useState(false);
  const [valueError, setValueError] = useState<string | null>(null);
  const [savingValue, setSavingValue] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Latest list-call token — used to ignore late responses when the user
  // re-filters mid-flight (otherwise stale results overwrite fresh ones).
  const listTokenRef = useRef(0);

  const load = useCallback(
    async (opts: { reset: boolean; cursorOverride?: string; prefixOverride?: string }) => {
      const activePrefix = opts.prefixOverride ?? prefix;
      const token = ++listTokenRef.current;
      if (opts.reset) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const params: KvBrowserListParams = {};
        if (opts.cursorOverride) params.cursor = opts.cursorOverride;
        if (activePrefix) params.prefix = activePrefix;
        if (capability.defaultPageSize) params.limit = capability.defaultPageSize;
        const result = await onListKeys(params);
        if (token !== listTokenRef.current) return;
        setItems((prev) => (opts.reset ? result.items : [...prev, ...result.items]));
        setCursor(result.nextCursor);
      } catch (e) {
        if (token === listTokenRef.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (token === listTokenRef.current) {
          setLoading(false);
          setLoadingMore(false);
          setInitialized(true);
        }
      }
    },
    [onListKeys, prefix, capability.defaultPageSize],
  );

  useEffect(() => {
    void load({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = value !== originalValue;
  const binary = useMemo(() => looksBinary(value), [value]);

  async function openKey(key: string) {
    if (selectedKey === key && !valueError) return;
    setSelectedKey(key);
    setValueLoading(true);
    setValueError(null);
    setSavedNote(null);
    setValue("");
    setOriginalValue("");
    try {
      const v = await onGetValue(key);
      setValue(v);
      setOriginalValue(v);
    } catch (e) {
      setValueError(e instanceof Error ? e.message : String(e));
    } finally {
      setValueLoading(false);
    }
  }

  async function saveValue() {
    if (!selectedKey || !dirty) return;
    setSavingValue(true);
    setValueError(null);
    setSavedNote(null);
    try {
      await onPutValue(selectedKey, value);
      setOriginalValue(value);
      setSavedNote("Saved");
      // Auto-clear the saved note after a beat so the user knows the next
      // edit is dirty again without manually dismissing it.
      window.setTimeout(() => setSavedNote(null), 2500);
    } catch (e) {
      setValueError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingValue(false);
    }
  }

  async function submitAdd() {
    if (!newKey.trim()) {
      setAddError("Key name is required.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await onPutValue(newKey, newValue);
      setShowAdd(false);
      setNewKey("");
      setNewValue("");
      await load({ reset: true });
      setSelectedKey(newKey);
      setValue(newValue);
      setOriginalValue(newValue);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function submitDelete(key: string) {
    setDeleting(true);
    try {
      await onDeleteKey(key);
      setConfirmDelete(null);
      if (selectedKey === key) {
        setSelectedKey(null);
        setValue("");
        setOriginalValue("");
      }
      await load({ reset: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header — namespace label + filter + add button */}
      <div className="shrink-0 px-4 py-3 border-b border-border flex gap-2 items-center">
        {capability.namespaceLabel && (
          <span
            className="text-sm text-on-surface-secondary truncate"
            title={capability.namespaceLabel}
          >
            {capability.namespaceLabel}
          </span>
        )}
        <input
          type="text"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load({ reset: true });
          }}
          placeholder="Filter by prefix…"
          aria-label="Filter keys by prefix"
          className="flex-1 px-3 py-1.5 rounded text-sm bg-surface-overlay border border-border text-on-surface placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
        />
        <button
          type="button"
          onClick={() => void load({ reset: true })}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary border border-border disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading…" : "Reload"}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowAdd(true);
            setNewKey("");
            setNewValue("");
            setAddError(null);
          }}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent/90 hover:bg-accent text-white transition-colors"
        >
          + Add key
        </button>
      </div>

      {capability.helpText && (
        <div className="shrink-0 px-4 py-2 border-b border-border text-xs text-on-surface-tertiary">
          {capability.helpText}
        </div>
      )}

      {error && (
        <div className="shrink-0 px-4 py-2 border-b border-border bg-red-500/10 text-red-400 text-xs font-mono whitespace-pre-wrap">
          {error}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left column — key list */}
        <div className="w-72 shrink-0 border-r border-border flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            {!initialized && loading ? (
              <div className="flex items-center justify-center py-16 text-on-surface-faint text-sm">
                Loading keys…
              </div>
            ) : items.length === 0 && !loading ? (
              <div className="flex flex-col items-center justify-center py-16 px-4 text-on-surface-faint text-sm text-center gap-2">
                <p>No keys found.</p>
                <p className="text-xs">Use "+ Add key" to create one.</p>
              </div>
            ) : (
              <div role="listbox" aria-label="KV keys" className="py-1">
                {items.map((item) => {
                  const isActive = selectedKey === item.name;
                  return (
                    <div key={item.name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onClick={() => void openKey(item.name)}
                        className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate hover:bg-surface-raised/40 transition-colors ${
                          isActive
                            ? "bg-surface-raised/60 text-on-surface"
                            : "text-on-surface-secondary"
                        }`}
                        title={item.name}
                      >
                        {item.name}
                        {item.expiration ? (
                          <span className="ml-2 text-on-surface-faint text-[10px]">
                            exp {new Date(item.expiration * 1000).toLocaleDateString()}
                          </span>
                        ) : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {cursor && (
            <div className="shrink-0 px-3 py-2 border-t border-border">
              <button
                type="button"
                onClick={() => void load({ reset: false, cursorOverride: cursor })}
                disabled={loadingMore}
                className="w-full px-3 py-1.5 text-xs font-medium rounded-md bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary border border-border disabled:opacity-50 transition-colors"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>

        {/* Right column — value editor */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {!selectedKey ? (
            <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm">
              Pick a key on the left to view or edit its value.
            </div>
          ) : (
            <>
              <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-3 min-h-[44px]">
                <span
                  className="font-mono text-sm text-on-surface truncate flex-1"
                  title={selectedKey}
                >
                  {selectedKey}
                </span>
                {savedNote && (
                  <span className="text-xs text-emerald-400" aria-live="polite">
                    {savedNote}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void saveValue()}
                  disabled={!dirty || savingValue || valueLoading || binary}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent/90 hover:bg-accent text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {savingValue ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(selectedKey)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-overlay hover:bg-red-500/20 text-red-400 border border-border transition-colors"
                >
                  Delete
                </button>
              </div>

              {valueError && (
                <div className="shrink-0 px-4 py-2 border-b border-border bg-red-500/10 text-red-400 text-xs font-mono whitespace-pre-wrap">
                  {valueError}
                </div>
              )}

              {binary && !valueLoading && (
                <div className="shrink-0 px-4 py-2 border-b border-border bg-yellow-500/10 text-yellow-400 text-xs">
                  This value looks binary, editing has been disabled to avoid corrupting it. Delete
                  the key if you need to replace it.
                </div>
              )}

              <div className="flex-1 overflow-hidden min-h-0">
                {valueLoading ? (
                  <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
                    Loading value…
                  </div>
                ) : (
                  <textarea
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    readOnly={binary}
                    aria-label={`Value for ${selectedKey}`}
                    spellCheck={false}
                    className="w-full h-full px-4 py-3 bg-surface-sunken text-on-surface font-mono text-xs resize-none focus:outline-none"
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Add-key modal */}
      {showAdd && (
        <Modal onClose={() => (adding ? undefined : setShowAdd(false))} ariaLabel="Add KV pair">
          <div className="p-5 w-[480px] max-w-[90vw]">
            <h2 className="text-base font-semibold text-on-surface mb-3">Add KV pair</h2>
            <label
              className="block text-xs font-medium text-on-surface-muted mb-1"
              htmlFor="kv-new-key"
            >
              Key
            </label>
            <input
              id="kv-new-key"
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              autoFocus
              spellCheck={false}
              className="w-full px-3 py-2 mb-3 rounded text-sm bg-surface-overlay border border-border text-on-surface font-mono focus:outline-none focus:border-border-strong"
            />
            <label
              className="block text-xs font-medium text-on-surface-muted mb-1"
              htmlFor="kv-new-value"
            >
              Value
            </label>
            <textarea
              id="kv-new-value"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              rows={8}
              spellCheck={false}
              className="w-full px-3 py-2 mb-3 rounded text-xs bg-surface-overlay border border-border text-on-surface font-mono focus:outline-none focus:border-border-strong"
            />
            {addError && (
              <div className="mb-3 text-xs text-red-400 font-mono whitespace-pre-wrap">
                {addError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                disabled={adding}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary border border-border disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitAdd()}
                disabled={adding}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent/90 hover:bg-accent text-white disabled:opacity-50 transition-colors"
              >
                {adding ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete-confirm modal */}
      {confirmDelete && (
        <Modal
          onClose={() => (deleting ? undefined : setConfirmDelete(null))}
          ariaLabel="Delete key"
        >
          <div className="p-5 w-[420px] max-w-[90vw]">
            <h2 className="text-base font-semibold text-on-surface mb-2">Delete key?</h2>
            <p className="text-sm text-on-surface-secondary mb-4">
              <code className="font-mono text-xs">{confirmDelete}</code> will be permanently removed
              from the namespace.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary border border-border disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitDelete(confirmDelete)}
                disabled={deleting}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-500/90 hover:bg-red-500 text-white disabled:opacity-50 transition-colors"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
