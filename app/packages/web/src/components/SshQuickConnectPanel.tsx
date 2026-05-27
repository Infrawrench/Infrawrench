import { useState, useEffect, useCallback } from "react";
import { deriveSSHUsername, formatErrorMessage, toast, SshKeyRadioGroup } from "@infrawrench/ui";
import { apiGet } from "@/lib/api";
import type { SshKey } from "@/lib/api-types";
import { useOrgId } from "@/lib/useOrgId";

interface SshQuickConnectPanelProps {
  host: string;
  defaultUsername?: string;
  onConnect: (config: { sshKeyId: string; username: string }) => void;
}

export function SshQuickConnectPanel({
  host,
  defaultUsername,
  onConnect,
}: SshQuickConnectPanelProps) {
  const orgId = useOrgId();
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [username, setUsername] = useState(defaultUsername ?? "root");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`)
      .then((result) => {
        setKeys(result);
        if (result.length > 0) {
          const effectiveUsername = defaultUsername ?? "root";
          const matchByUsername = result.find(
            (k) => k.name.toLowerCase() === effectiveUsername.toLowerCase(),
          );
          const picked = matchByUsername ?? result[0]!;
          setSelectedKeyId(picked.id);
          if (!defaultUsername && !matchByUsername && picked.ownerName) {
            setUsername(deriveSSHUsername(picked.ownerName));
          }
        }
      })
      .catch((err) => toast.error(`Couldn't load SSH keys: ${formatErrorMessage(err)}`))
      .finally(() => setLoading(false));
  }, []);

  const handleConnect = useCallback(() => {
    if (!selectedKeyId) return;
    onConnect({ sshKeyId: selectedKeyId, username });
  }, [selectedKeyId, username, onConnect]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-muted text-sm">
        Loading SSH keys…
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-full max-w-md space-y-4 p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className="font-mono text-green-600 text-xs">SSH</span>
          <span className="text-on-surface-muted font-mono text-xs">{host}</span>
        </div>

        {/* Username */}
        <div className="flex items-center gap-3">
          <label className="text-xs text-on-surface-muted w-20 shrink-0">Username</label>
          <input
            value={username}
            onChange={(e) => {
              const next = e.target.value;
              setUsername(next);
              const match = keys.find((k) => k.name.toLowerCase() === next.toLowerCase());
              if (match) setSelectedKeyId(match.id);
            }}
            className="flex-1 bg-surface-raised border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
            placeholder="root"
            spellCheck={false}
          />
        </div>

        {/* Key picker */}
        <div className="flex items-start gap-3">
          <label className="text-xs text-on-surface-muted w-20 shrink-0 pt-1">SSH Key</label>
          <div className="flex-1 space-y-1">
            {keys.length === 0 ? (
              <p className="text-xs text-on-surface-faint py-1">
                No SSH keys found. Go to Settings to create one.
              </p>
            ) : (
              <SshKeyRadioGroup
                ariaLabel="SSH Key"
                selectedId={selectedKeyId}
                onChange={(id) => {
                  setSelectedKeyId(id);
                  const k = keys.find((x) => x.id === id);
                  if (!defaultUsername && k?.ownerName) {
                    const derivedUsername = deriveSSHUsername(k.ownerName);
                    setUsername((prev) =>
                      prev === "root" || prev === derivedUsername ? derivedUsername : prev,
                    );
                  }
                }}
                keys={keys.map((k) => ({
                  id: k.id,
                  label: k.name,
                  meta: k.ownerName,
                }))}
              />
            )}
          </div>
        </div>

        {/* Connect button */}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={handleConnect}
            disabled={!selectedKeyId}
            className="px-4 py-1.5 rounded-lg bg-green-100 dark:bg-green-900 border border-green-300 dark:border-green-700 hover:bg-green-200 dark:hover:bg-green-800 hover:border-green-400 dark:hover:border-green-600 text-green-700 dark:text-green-300 hover:text-green-800 dark:hover:text-green-200 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
