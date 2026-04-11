import { useState, useEffect } from "react";

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
  cloudEnabled = true,
  showCloudSection = true,
  onCloudSignIn,
}: SshKeyPickerProps) {
  const [cloudKeys, setCloudKeys] = useState<SshKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showGenerate, setShowGenerate] = useState(false);
  const [newName, setNewName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedPrivateKey, setGeneratedPrivateKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cloudEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    loadKeys()
      .then((keys) => {
        if (!cancelled) setCloudKeys(keys);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false);
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
      setError(e instanceof Error ? e.message : "Failed to generate key");
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
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {/* None option */}
      <button
        onClick={() => onChange("")}
        className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-2 border-b border-gray-700/40 ${
          noneSelected ? "bg-blue-600/20 text-blue-300" : "text-gray-500 hover:bg-gray-800"
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${noneSelected ? "bg-blue-400" : "bg-gray-700"}`}
        />
        No SSH key
      </button>

      <div className="max-h-52 overflow-y-auto">
        {loading && <p className="px-3 py-2 text-xs text-gray-600">Loading keys...</p>}

        {/* System keys section (desktop only) */}
        {systemKeys && systemKeys.length > 0 && (
          <div>
            <div className="px-3 py-1 bg-gray-800/30 border-b border-gray-700/40">
              <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">
                System (~/.ssh)
              </span>
            </div>
            {systemKeys.map((k) => {
              const selected = value === k.publicKey;
              const keyType = k.publicKey.split(" ")[0] ?? "";
              return (
                <button
                  key={k.name}
                  onClick={() => onChange(k.publicKey)}
                  className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
                    selected ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-gray-700"}`}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium font-mono block text-xs">{k.name}</span>
                    <span className="text-[11px] text-gray-600">
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
            <div className="px-3 py-1 bg-gray-800/30 border-b border-gray-700/40 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">
                Cloud keys
              </span>
              {cloudEnabled && cloudKeys.length > 0 && (
                <span className="text-[10px] text-gray-700">{cloudKeys.length}</span>
              )}
            </div>
            {!cloudEnabled ? (
              <div className="px-3 py-2.5 flex items-center justify-between">
                <span className="text-xs text-gray-600">Sign in to use cloud-managed keys</span>
                {onCloudSignIn && (
                  <button
                    onClick={onCloudSignIn}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Sign in
                  </button>
                )}
              </div>
            ) : (
              <>
                {cloudKeys.length === 0 && !showGenerate && (
                  <p className="px-3 py-2 text-xs text-gray-600">No cloud keys yet.</p>
                )}
                {cloudKeys.map((k) => {
                  const selected = value === k.publicKey;
                  const isOwn = currentUserId ? k.userId === currentUserId : true;
                  return (
                    <div
                      key={k.id}
                      onClick={() => onChange(k.publicKey)}
                      className={`group w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 cursor-pointer ${
                        selected
                          ? "bg-blue-600/20 text-blue-300"
                          : "text-gray-300 hover:bg-gray-800"
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-gray-700"}`}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="font-medium block text-xs">{k.name}</span>
                        <span className="text-[11px] text-gray-600">
                          {k.keyType && <>{k.keyType} · </>}
                          {k.ownerName ?? k.ownerEmail ?? "you"}
                        </span>
                      </span>
                      {isOwn && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(k.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 text-xs px-1 transition-all flex-shrink-0"
                          title="Remove key"
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
        <div className="border-t border-gray-700/40 p-3 space-y-2 bg-yellow-900/10">
          <p className="text-xs text-yellow-400 font-medium">
            Save this private key now — it won't be shown again.
          </p>
          <pre className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[10px] text-gray-300 font-mono overflow-x-auto max-h-32 overflow-y-auto select-all whitespace-pre">
            {generatedPrivateKey}
          </pre>
          <div className="flex gap-2 justify-end">
            <button
              onClick={handleCopyPrivateKey}
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors"
            >
              Copy
            </button>
            <button
              onClick={handleDismissPrivateKey}
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Generate key form */}
      {showCloudSection &&
        cloudEnabled &&
        !generatedPrivateKey &&
        (showGenerate ? (
          <div className="border-t border-gray-700/40 p-3 space-y-2 bg-gray-900/50">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-gray-500"
              placeholder="Key name (e.g. deploy-key)"
              spellCheck={false}
              autoFocus
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowGenerate(false);
                  setNewName("");
                  setError(null);
                }}
                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleGenerate()}
                disabled={generating || !newName.trim()}
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {generating ? "Generating..." : "Generate Key"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowGenerate(true)}
            className="w-full px-3 py-2 text-xs text-gray-600 hover:text-gray-400 hover:bg-gray-800/50 transition-colors text-left border-t border-gray-700/40"
          >
            + Generate SSH key
          </button>
        ))}
    </div>
  );
}
