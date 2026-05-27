import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Modal } from "@infrawrench/ui";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import type { SshKey } from "@/lib/api-types";

export const Route = createFileRoute("/org/$orgId/settings/ssh-keys")({
  component: SshKeysPage,
});

function SshKeysPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/ssh-keys" });
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<{
    publicKey: string;
    privateKey: string;
  } | null>(null);

  async function load() {
    setLoading(true);
    const result = await apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`);
    setKeys(result);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(id: string) {
    await apiDelete(`/api/org/${orgId}/ssh-keys/${id}`);
    await load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">SSH Keys</h1>
          <p className="text-sm text-on-surface-muted mt-1">
            SSH keys shared across your organization for connecting to resources.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg transition-colors"
          >
            Import Key
          </button>
          <button
            type="button"
            onClick={() => setShowGenerate(true)}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            Generate Key
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No SSH keys yet. Generate a new keypair or import an existing public key.
        </p>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Type
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Fingerprint
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Source
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Owner
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Added
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-b border-border/50 hover:bg-surface-raised/50">
                  <td className="px-4 py-2 text-sm text-on-surface-secondary">{key.name}</td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono">
                    {key.keyType}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono truncate max-w-[200px]">
                    {key.fingerprint ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    {key.isImported ? (
                      <span className="text-xs text-on-surface-tertiary">Imported</span>
                    ) : (
                      <span className="text-xs text-on-surface-tertiary">Generated</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">{key.ownerName}</td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(key.publicKey);
                        }}
                        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                      >
                        Copy public key
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(key.id)}
                        className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showGenerate && (
        <GenerateKeyModal
          onClose={() => setShowGenerate(false)}
          onCreated={(result) => {
            setGeneratedKey(result);
            setShowGenerate(false);
            void load();
          }}
        />
      )}

      {showImport && (
        <ImportKeyModal
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            void load();
          }}
        />
      )}

      {generatedKey && (
        <Modal onClose={() => setGeneratedKey(null)}>
          <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-lg shadow-2xl p-5">
            <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">Key Generated</h2>
            <p className="text-xs text-on-surface-tertiary mb-3">
              Copy the private key now. You won&apos;t be able to see it again.
            </p>
            <div className="space-y-3">
              <div>
                <span className="block text-xs text-on-surface-muted mb-1">Public Key</span>
                <div className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs text-on-surface-secondary break-all select-all max-h-20 overflow-auto">
                  {generatedKey.publicKey}
                </div>
              </div>
              <div>
                <span className="block text-xs text-on-surface-muted mb-1">Private Key</span>
                <div className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs text-on-surface-secondary break-all select-all max-h-32 overflow-auto whitespace-pre">
                  {generatedKey.privateKey}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(generatedKey.privateKey);
              }}
              className="mt-3 w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              Copy private key to clipboard
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GenerateKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: { publicKey: string; privateKey: string }) => void;
}) {
  const orgId = useOrgId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiPost<{
        id: string;
        publicKey: string;
        privateKey: string;
      }>(`/api/org/${orgId}/ssh-keys`, { name: name.trim() });
      onCreated({ publicKey: result.publicKey, privateKey: result.privateKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate key");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Generate SSH Key</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg"
          >
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label
              id="generate-ssh-key-name-label"
              htmlFor="generate-ssh-key-name"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              Key name
            </label>
            <input
              id="generate-ssh-key-name"
              aria-labelledby="generate-ssh-key-name-label"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="production-bastion"
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
            />
          </div>
          <p className="text-xs text-on-surface-muted">
            An Ed25519 keypair will be generated. The private key is only shown once. The public key
            will be shared with all organization members.
          </p>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving}
            className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {saving ? "Generating..." : "Generate key"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ImportKeyModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const orgId = useOrgId();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!publicKey.trim()) {
      setError("Public key is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/org/${orgId}/ssh-keys/import`, {
        name: name.trim(),
        publicKey: publicKey.trim(),
      });
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import key");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Import SSH Key</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg"
          >
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label
              id="import-ssh-key-name-label"
              htmlFor="import-ssh-key-name"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              Key name
            </label>
            <input
              id="import-ssh-key-name"
              aria-labelledby="import-ssh-key-name-label"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-existing-key"
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
            />
          </div>
          <div>
            <label
              id="import-ssh-public-key-label"
              htmlFor="import-ssh-public-key"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              Public key
            </label>
            <textarea
              id="import-ssh-public-key"
              aria-labelledby="import-ssh-public-key-label"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder="ssh-ed25519 AAAA... user@host"
              rows={4}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong font-mono resize-none"
            />
          </div>
          <p className="text-xs text-on-surface-muted">
            Paste your public key (e.g. from{" "}
            <code className="text-on-surface-tertiary">~/.ssh/id_ed25519.pub</code>). Only the
            public key is stored. The key will be shared with all organization members.
          </p>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={saving}
            className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {saving ? "Importing..." : "Import key"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
