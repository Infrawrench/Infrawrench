import { useState, useEffect, useMemo } from "react";
import { useGT } from "gt-react";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import { API_KEY_SCOPE_GROUPS } from "./api-key-scopes.js";
import { useSettingsHost } from "./host.js";

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

export function ApiKeysSection() {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const result = await api.get<ApiKeySummary[]>(`/api/org/${orgId}/api-keys`);
    setKeys(result);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRevoke(id: string) {
    await api.post(`/api/org/${orgId}/api-keys/${id}/revoke`);
    await load();
  }

  async function handleRotate(id: string) {
    const result = await api.post<{ id: string; key: string }>(
      `/api/org/${orgId}/api-keys/${id}/rotate`,
    );
    setNewKey(result.key);
    await load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">{gt("API Keys")}</h1>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          {gt("Create API Key")}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-on-surface-muted">{gt("No API keys yet.")}</p>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Name")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Key")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Scopes")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Last used")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Status")}
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  {gt("Actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-b border-border/50 hover:bg-surface-raised/50">
                  <td className="px-4 py-2 text-sm text-on-surface-secondary">{key.name}</td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono">
                    {key.prefix}...
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary">
                    {gt("{count} scope{suffix}", {
                      count: key.scopes.length,
                      suffix: key.scopes.length !== 1 ? "s" : "",
                    })}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : gt("Never")}
                  </td>
                  <td className="px-4 py-2">
                    {key.revokedAt ? (
                      <span className="text-xs text-danger">{gt("Revoked")}</span>
                    ) : key.expiresAt && new Date(key.expiresAt) < new Date() ? (
                      <span className="text-xs text-warning">{gt("Expired")}</span>
                    ) : (
                      <span className="text-xs text-success">{gt("Active")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!key.revokedAt && (
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => void handleRotate(key.id)}
                          className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                        >
                          {gt("Rotate")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRevoke(key.id)}
                          className="text-xs text-danger hover:text-danger-strong"
                        >
                          {gt("Revoke")}
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
        <Modal onClose={() => setNewKey(null)} ariaLabel={gt("API Key Created")}>
          <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl p-5">
            <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">
              {gt("API Key Created")}
            </h2>
            <p className="text-xs text-on-surface-tertiary mb-3">
              {gt("Copy this key now. You won't be able to see it again.")}
            </p>
            <div className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs text-on-surface-secondary break-all select-all">
              {newKey}
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(newKey);
              }}
              className="mt-3 w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              {gt("Copy to clipboard")}
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
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api } = useSettingsHost();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [scopeFilter, setScopeFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fifty-five checkboxes is the honest size of the permission catalog, and a
  // scroll through seven headings is a poor way to find `costs:write`. Match on
  // the permission string as well as the label so someone who arrived from the
  // docs (which quote the strings) can paste what they read.
  const visibleGroups = useMemo(() => {
    const needle = scopeFilter.trim().toLowerCase();
    if (!needle) return API_KEY_SCOPE_GROUPS;
    return API_KEY_SCOPE_GROUPS.map((group) => ({
      ...group,
      scopes: group.scopes.filter(
        (scope) =>
          scope.value.toLowerCase().includes(needle) ||
          gtData(scope.label).toLowerCase().includes(needle) ||
          gtData(group.title).toLowerCase().includes(needle),
      ),
    })).filter((group) => group.scopes.length > 0);
  }, [scopeFilter, gtData]);

  async function handleCreate() {
    if (!name.trim()) {
      setError(gt("Name is required"));
      return;
    }
    if (scopes.size === 0) {
      setError(gt("Select at least one scope"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<{ id: string; key: string }>(`/api/org/${orgId}/api-keys`, {
        name: name.trim(),
        scopes: [...scopes],
      });
      onCreated(result.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to create key"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Create API Key")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Create API Key")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={gt("Close")}
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg"
          >
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label htmlFor="api-key-name" className="block text-xs text-on-surface-tertiary mb-1">
              {gt("Name")}
            </label>
            <input
              id="api-key-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={gt("My desktop key")}
              {...(error ? { "aria-describedby": "api-key-name-error" } : {})}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
            />
          </div>
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-xs text-on-surface-tertiary">
                {gt("Scopes ({count} selected)", { count: scopes.size })}
              </span>
              <input
                type="search"
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value)}
                placeholder={gt("Filter scopes")}
                aria-label={gt("Filter scopes")}
                className="w-40 bg-surface-overlay border border-border-strong rounded-lg px-2 py-1 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
              />
            </div>
            <div className="max-h-72 overflow-y-auto border border-border rounded-lg p-3 space-y-4">
              {visibleGroups.length === 0 ? (
                <p className="text-xs text-on-surface-muted">
                  {gt("No scopes match that filter.")}
                </p>
              ) : (
                visibleGroups.map((group) => (
                  <fieldset key={group.title}>
                    <legend className="text-[11px] uppercase tracking-wide text-on-surface-faint mb-1.5">
                      {gtData(group.title)}
                    </legend>
                    <div className="space-y-1.5">
                      {group.scopes.map((scope) => (
                        <label
                          key={scope.value}
                          className="flex items-start gap-2 text-sm text-on-surface-secondary"
                        >
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
                            aria-label={gtData(scope.label)}
                            className="mt-1 rounded border-border-strong"
                          />
                          <span>
                            {gtData(scope.label)}{" "}
                            <code className="text-[11px] text-on-surface-faint">{scope.value}</code>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))
              )}
            </div>
            <p className="mt-2 text-[11px] text-on-surface-faint">
              {gt(
                "Pick the narrowest set that does the job. Whatever you select, a key can never exceed the role of the person who created it, and API keys can never manage keys, billing, team membership or break-glass approvals.",
              )}
            </p>
          </div>
          {error && (
            <p id="api-key-name-error" role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving}
            className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {saving ? gt("Creating...") : gt("Create key")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
