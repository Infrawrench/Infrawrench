import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Modal } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";

interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const AVAILABLE_SCOPES = [
  { value: "sync:read", label: "Sync (read)" },
  { value: "sync:write", label: "Sync (write)" },
  { value: "resources:read", label: "Resources (read)" },
  { value: "resources:write", label: "Resources (write)" },
  { value: "dashboards:read", label: "Dashboards (read)" },
  { value: "dashboards:write", label: "Dashboards (write)" },
];

export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const result = await apiGet<ApiKeySummary[]>("/api/api-keys");
    setKeys(result);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleRevoke(id: string) {
    await apiPost(`/api/api-keys/${id}/revoke`);
    await load();
  }

  async function handleRotate(id: string) {
    const result = await apiPost<{ id: string; key: string }>(`/api/api-keys/${id}/rotate`);
    setNewKey(result.key);
    await load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">API Keys</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Create API Key
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-600">Loading...</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-gray-500">No API keys yet.</p>
      ) : (
        <div className="border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500">
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Key</th>
                <th className="text-left px-4 py-2 font-medium">Scopes</th>
                <th className="text-left px-4 py-2 font-medium">Last used</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                  <td className="px-4 py-2 text-sm text-gray-200">{key.name}</td>
                  <td className="px-4 py-2 text-xs text-gray-400 font-mono">{key.prefix}...</td>
                  <td className="px-4 py-2 text-xs text-gray-400">
                    {key.scopes.length} scope{key.scopes.length !== 1 ? "s" : ""}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleDateString()
                      : "Never"}
                  </td>
                  <td className="px-4 py-2">
                    {key.revokedAt ? (
                      <span className="text-xs text-red-400">Revoked</span>
                    ) : key.expiresAt && new Date(key.expiresAt) < new Date() ? (
                      <span className="text-xs text-yellow-400">Expired</span>
                    ) : (
                      <span className="text-xs text-green-400">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!key.revokedAt && (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => void handleRotate(key.id)}
                          className="text-xs text-gray-400 hover:text-gray-200"
                        >
                          Rotate
                        </button>
                        <button
                          onClick={() => void handleRevoke(key.id)}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateApiKeyModal
          onClose={() => setShowCreate(false)}
          onCreated={(key) => {
            setNewKey(key);
            setShowCreate(false);
            void load();
          }}
        />
      )}

      {newKey && (
        <Modal onClose={() => setNewKey(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl p-5">
            <h2 className="text-sm font-semibold text-gray-200 mb-3">API Key Created</h2>
            <p className="text-xs text-gray-400 mb-3">
              Copy this key now. You won&apos;t be able to see it again.
            </p>
            <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 font-mono text-xs text-gray-200 break-all select-all">
              {newKey}
            </div>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(newKey);
              }}
              className="mt-3 w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              Copy to clipboard
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateApiKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (scopes.size === 0) {
      setError("Select at least one scope");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiPost<{ id: string; key: string }>("/api/api-keys", {
        name: name.trim(),
        scopes: [...scopes],
      });
      onCreated(result.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">Create API Key</h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-400 text-lg">
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My desktop key"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-2">Scopes</label>
            <div className="space-y-2">
              {AVAILABLE_SCOPES.map((scope) => (
                <label key={scope.value} className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="checkbox"
                    checked={scopes.has(scope.value)}
                    onChange={(e) => {
                      setScopes((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(scope.value);
                        else next.delete(scope.value);
                        return next;
                      });
                    }}
                    className="rounded border-gray-600"
                  />
                  {scope.label}
                </label>
              ))}
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={() => void handleCreate()}
            disabled={saving}
            className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {saving ? "Creating..." : "Create key"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
