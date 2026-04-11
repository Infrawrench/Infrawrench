import { useState, useEffect, useCallback } from "react";
import { deriveSSHUsername } from "@infrawrench/ui";
import { apiGet } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

interface SshKey {
  id: string;
  name: string;
  keyType: string;
  publicKey: string;
  ownerName: string;
}

interface SshQuickConnectPanelProps {
  host: string;
  onConnect: (config: { sshKeyId: string; username: string }) => void;
}

export function SshQuickConnectPanel({ host, onConnect }: SshQuickConnectPanelProps) {
  const orgId = useOrgId();
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [username, setUsername] = useState("root");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`)
      .then((result) => {
        setKeys(result);
        if (result.length > 0) {
          setSelectedKeyId(result[0]!.id);
          // Auto-derive username from key owner (matches desktop behavior)
          if (result[0]!.ownerName) {
            setUsername(deriveSSHUsername(result[0]!.ownerName));
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleConnect = useCallback(() => {
    if (!selectedKeyId) return;
    onConnect({ sshKeyId: selectedKeyId, username });
  }, [selectedKeyId, username, onConnect]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading SSH keys...
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-full max-w-md space-y-4 p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className="font-mono text-green-600 text-xs">SSH</span>
          <span className="text-gray-500 font-mono text-xs">{host}</span>
        </div>

        {/* Username */}
        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-500 w-20 shrink-0">Username</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
            placeholder="root"
            spellCheck={false}
          />
        </div>

        {/* Key picker */}
        <div className="flex items-start gap-3">
          <label className="text-xs text-gray-500 w-20 shrink-0 pt-1">SSH Key</label>
          <div className="flex-1 space-y-1">
            {keys.length === 0 ? (
              <p className="text-xs text-gray-600 py-1">
                No SSH keys found. Go to Settings to create one.
              </p>
            ) : (
              keys.map((k) => (
                <div
                  key={k.id}
                  onClick={() => {
                    setSelectedKeyId(k.id);
                    if (k.ownerName) {
                      const derivedUsername = deriveSSHUsername(k.ownerName);
                      setUsername((prev) => (prev === "root" || prev === derivedUsername ? derivedUsername : prev));
                    }
                  }}
                  className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    selectedKeyId === k.id
                      ? "bg-blue-950 border border-blue-800 text-blue-300"
                      : "hover:bg-gray-800 border border-transparent text-gray-400"
                  }`}
                >
                  <span className="text-xs shrink-0">{selectedKeyId === k.id ? "\u25c9" : "\u25cb"}</span>
                  <span className="text-xs font-mono flex-1 truncate">{k.name}</span>
                  <span className="text-xs text-gray-600">{k.ownerName}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Connect button */}
        <div className="flex justify-end pt-1">
          <button
            onClick={handleConnect}
            disabled={!selectedKeyId}
            className="px-4 py-1.5 rounded-lg bg-green-900 border border-green-700 hover:bg-green-800 hover:border-green-600 text-green-300 hover:text-green-200 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            &#x2328; Connect
          </button>
        </div>
      </div>
    </div>
  );
}
