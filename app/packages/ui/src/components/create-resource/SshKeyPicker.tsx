import { useState, useEffect, useRef } from "react";
import { formatErrorMessage } from "../../utils.js";

export interface SshKeyEntry {
  id: string;
  name: string;
  publicKey: string;
  keyType?: string | null;
  /** Owner info — visible to all org members */
  ownerEmail?: string;
  ownerName?: string;
  userId?: string;
}

export interface SystemSshKey {
  name: string;
  publicKey: string;
}

export interface AgentSshKey {
  name: string;
  publicKey: string;
  /** OpenSSH algorithm name, e.g. "ssh-ed25519". Used for the sublabel. */
  keyType?: string;
}

export interface SshKeyPickerProps {
  value: string;
  onChange: (publicKey: string) => void;
  /** Load cloud-managed keys from the backend */
  loadKeys: () => Promise<SshKeyEntry[]>;
  /** Generate a new keypair on the server, returns the created entry (with private key for download) */
  generateKey: (name: string) => Promise<SshKeyEntry & { privateKey?: string }>;
  /** Delete a key from the backend (only works for own keys) */
  deleteKey: (id: string) => Promise<void>;
  /** The current user's ID — used to determine which keys are deletable */
  currentUserId?: string;
  /** System-level keys (e.g. from ~/.ssh on desktop). Omit on web. */
  systemKeys?: SystemSshKey[];
  /** Public keys held by the 1Password SSH agent. Desktop-only. */
  onePasswordKeys?: AgentSshKey[];
  /** When false, shows a sign-in prompt instead of cloud keys. Defaults to true. */
  cloudEnabled?: boolean;
  /** When false, hides the cloud keys section entirely (e.g. desktop in local-only mode). Defaults to true. */
  showCloudSection?: boolean;
  /** Called when the user clicks "Sign in" in the cloud keys section. Omit on web (always authed). */
  onCloudSignIn?: () => void;
}

export function SshKeyPicker({
  value,
  onChange,
  loadKeys,
  generateKey,
  deleteKey,
  currentUserId,
  systemKeys,
  onePasswordKeys,
  cloudEnabled = true,
  showCloudSection = true,
  onCloudSignIn,
}: SshKeyPickerProps) {
  const [cloudKeys, setCloudKeys] = useState<SshKeyEntry[]>([]);
  const [cloudLoading, setCloudLoading] = useState(true);
  const loading = cloudEnabled ? cloudLoading : false;
  const [showGenerate, setShowGenerate] = useState(false);
  const newNameRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState("");

  // Move focus to the name field when the generate-key form opens (user
  // action), rather than autoFocus which would steal focus on initial render.
  useEffect(() => {
    if (showGenerate) newNameRef.current?.focus();
  }, [showGenerate]);
  const [generating, setGenerating] = useState(false);
  const [generatedPrivateKey, setGeneratedPrivateKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cloudEnabled) return;
    let cancelled = false;
    loadKeys()
      .then((keys) => {
        if (!cancelled) setCloudKeys(keys);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setCloudLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadKeys, cloudEnabled]);

  async function handleGenerate() {
    if (!newName.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await generateKey(newName.trim());
      setCloudKeys((prev) => [...prev, result]);
      onChange(result.publicKey);
      if (result.privateKey) {
        setGeneratedPrivateKey(result.privateKey);
      } else {
        setNewName("");
        setShowGenerate(false);
      }
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setGenerating(false);
    }
  }

  function handleDismissPrivateKey() {
    setGeneratedPrivateKey(null);
    setNewName("");
    setShowGenerate(false);
  }

  function handleCopyPrivateKey() {
    if (generatedPrivateKey) {
      void navigator.clipboard.writeText(generatedPrivateKey);
    }
  }

  async function handleDelete(id: string) {
    const key = cloudKeys.find((k) => k.id === id);
    try {
      await deleteKey(id);
      setCloudKeys((prev) => prev.filter((k) => k.id !== id));
      if (key && value === key.publicKey) onChange("");
    } catch (e) {
      console.error("Failed to delete key:", e);
    }
  }

  const noneSelected = !value;

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      {/* None option */}
      <button
        type="button"
        onClick={() => onChange("")}
        className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-2 border-b border-border-strong/40 ${
          noneSelected
            ? "bg-accent-muted text-accent-on-muted"
            : "text-on-surface-muted hover:bg-surface-overlay"
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${noneSelected ? "bg-blue-400" : "bg-surface-sunken"}`}
        />
        No SSH key
      </button>

      <div className="max-h-52 overflow-y-auto">
        {loading && <p className="px-3 py-2 text-xs text-on-surface-faint">Loading keys…</p>}

        {/* 1Password agent keys (desktop only) */}
        {onePasswordKeys && onePasswordKeys.length > 0 && (
          <div>
            <div className="px-3 py-1 bg-surface-overlay/30 border-b border-border-strong/40">
              <span className="text-[10px] font-semibold text-on-surface-faint uppercase tracking-wide">
                1Password
              </span>
            </div>
            {onePasswordKeys.map((k) => {
              const selected = value === k.publicKey;
              const keyType = k.keyType ?? k.publicKey.split(" ")[0] ?? "";
              return (
                <button
                  type="button"
                  key={k.publicKey}
                  onClick={() => onChange(k.publicKey)}
                  className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
                    selected
                      ? "bg-accent-muted text-accent-on-muted"
                      : "text-on-surface-secondary hover:bg-surface-overlay"
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-surface-sunken"}`}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium block text-xs">{k.name}</span>
                    <span className="text-[11px] text-on-surface-faint">
                      1Password agent{keyType ? ` · ${keyType}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* System keys section (desktop only) */}
        {systemKeys && systemKeys.length > 0 && (
          <div>
            <div className="px-3 py-1 bg-surface-overlay/30 border-b border-border-strong/40">
              <span className="text-[10px] font-semibold text-on-surface-faint uppercase tracking-wide">
                System (~/.ssh)
              </span>
            </div>
            {systemKeys.map((k) => {
              const selected = value === k.publicKey;
              const keyType = k.publicKey.split(" ")[0] ?? "";
              return (
                <button
                  type="button"
                  key={k.name}
                  onClick={() => onChange(k.publicKey)}
                  className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
                    selected
                      ? "bg-accent-muted text-accent-on-muted"
                      : "text-on-surface-secondary hover:bg-surface-overlay"
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-surface-sunken"}`}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium font-mono block text-xs">{k.name}</span>
                    <span className="text-[11px] text-on-surface-faint">
                      ~/.ssh/{k.name}.pub · {keyType}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Cloud-managed keys section */}
        {!loading && showCloudSection && (
          <div>
            <div className="px-3 py-1 bg-surface-overlay/30 border-b border-border-strong/40 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-on-surface-faint uppercase tracking-wide">
                Cloud keys
              </span>
              {cloudEnabled && cloudKeys.length > 0 && (
                <span className="text-[10px] text-on-surface-faint">{cloudKeys.length}</span>
              )}
            </div>
            {!cloudEnabled ? (
              <div className="px-3 py-2.5 flex items-center justify-between">
                <span className="text-xs text-on-surface-faint">
                  Sign in to use cloud-managed keys
                </span>
                {onCloudSignIn && (
                  <button
                    type="button"
                    onClick={onCloudSignIn}
                    className="text-xs text-accent hover:text-accent-on-muted transition-colors"
                  >
                    Sign in
                  </button>
                )}
              </div>
            ) : (
              <>
                {cloudKeys.length === 0 && !showGenerate && (
                  <p className="px-3 py-2 text-xs text-on-surface-faint">No cloud keys yet.</p>
                )}
                {cloudKeys.map((k) => {
                  const selected = value === k.publicKey;
                  const isOwn = currentUserId ? k.userId === currentUserId : true;
                  return (
                    <div key={k.id} className="group relative flex items-stretch">
                      <button
                        type="button"
                        onClick={() => onChange(k.publicKey)}
                        className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 cursor-pointer ${
                          selected
                            ? "bg-accent-muted text-accent-on-muted"
                            : "text-on-surface-secondary hover:bg-surface-overlay"
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-surface-sunken"}`}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="font-medium block text-xs">{k.name}</span>
                          <span className="text-[11px] text-on-surface-faint">
                            {k.keyType && <>{k.keyType} · </>}
                            {k.ownerName ?? k.ownerEmail ?? "you"}
                          </span>
                        </span>
                      </button>
                      {isOwn && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(k.id);
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-on-surface-faint hover:text-red-400 text-xs px-1 transition-all flex-shrink-0"
                          title="Remove key"
                          aria-label={`Remove SSH key ${k.name}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* Private key display (shown once after generation) */}
      {showCloudSection && cloudEnabled && generatedPrivateKey && (
        <div className="border-t border-border-strong/40 p-3 space-y-2 bg-yellow-100 dark:bg-yellow-900/10">
          <p className="text-xs text-yellow-400 font-medium">
            Save this private key now, it won't be shown again.
          </p>
          <pre className="w-full bg-surface-raised border border-border-strong rounded px-2 py-1.5 text-[10px] text-on-surface-secondary font-mono overflow-x-auto max-h-32 overflow-y-auto select-all whitespace-pre">
            {generatedPrivateKey}
          </pre>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={handleCopyPrivateKey}
              className="px-3 py-1 rounded bg-surface-sunken hover:bg-surface-sunken text-xs text-on-surface-secondary transition-colors"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={handleDismissPrivateKey}
              className="px-3 py-1 rounded bg-surface-sunken hover:bg-surface-sunken text-xs text-on-surface-secondary transition-colors"
            >
              I've saved it
            </button>
          </div>
        </div>
      )}

      {/* Generate key form */}
      {showCloudSection &&
        cloudEnabled &&
        !generatedPrivateKey &&
        (showGenerate ? (
          <div className="border-t border-border-strong/40 p-3 space-y-2 bg-surface-raised/50">
            <input
              ref={newNameRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1.5 text-xs text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
              placeholder="Key name (e.g. deploy-key)"
              aria-label="Key name"
              spellCheck={false}
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowGenerate(false);
                  setNewName("");
                  setError(null);
                }}
                className="px-3 py-1 text-xs text-on-surface-muted hover:text-on-surface-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={generating || !newName.trim()}
                className="px-3 py-1 rounded bg-surface-sunken hover:bg-surface-sunken text-xs text-on-surface-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {generating ? "Generating..." : "Generate Key"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowGenerate(true)}
            className="w-full px-3 py-2 text-xs text-on-surface-faint hover:text-on-surface-tertiary hover:bg-surface-overlay/50 transition-colors text-left border-t border-border-strong/40"
          >
            + Generate SSH key
          </button>
        ))}
    </div>
  );
}
