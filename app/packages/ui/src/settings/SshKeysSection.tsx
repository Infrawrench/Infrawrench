import { useState, useEffect } from "react";
import { T, useGT } from "gt-react";
import { CI_GRANT_NAME, ciGrantNameFor, type CiAccessOverview } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { SshKey } from "../api-types.js";
import { useSettingsHost } from "./host.js";

export function SshKeysSection() {
  const { orgId, api, has } = useSettingsHost();
  const gt = useGT();
  // Lending a key to CI jobs is its owner's act, under `ssh-keys:write`.
  const canLend = has("ssh-keys:write");
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<{
    publicKey: string;
    privateKey: string;
  } | null>(null);

  // CI access, when CI is on for the organization (the route is a 404
  // otherwise): which keys are lent to CI jobs, and who is asking.
  const [ci, setCi] = useState<CiAccessOverview | null>(null);
  const [lending, setLending] = useState<SshKey | null>(null);

  async function load() {
    setLoading(true);
    const result = await api.get<SshKey[]>(`/api/org/${orgId}/ssh-keys`);
    setKeys(result);
    setLoading(false);
    setCi(await api.get<CiAccessOverview>(`/api/org/${orgId}/ci/access`).catch(() => null));
  }

  async function stopLending(id: string) {
    await api.put(`/api/org/${orgId}/ci/access/ssh-keys/${id}`, {
      enabled: false,
      ciName: "",
      repos: null,
      branchPattern: null,
    });
    await load();
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDelete(id: string) {
    await api.delete(`/api/org/${orgId}/ssh-keys/${id}`);
    await load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{gt("SSH Keys")}</h1>
          <p className="text-sm text-on-surface-muted mt-1">
            {gt("SSH keys shared across your organization for connecting to resources.")}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg transition-colors"
          >
            {gt("Import Key")}
          </button>
          <button
            type="button"
            onClick={() => setShowGenerate(true)}
            className="px-3 py-1.5 text-sm font-medium bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors"
          >
            {gt("Generate Key")}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          {gt("No SSH keys yet. Generate a new keypair or import an existing public key.")}
        </p>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Name")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Type")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Fingerprint")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Source")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Owner")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Added")}
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
                    {key.keyType}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono truncate max-w-[200px]">
                    {key.fingerprint ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    {key.isImported ? (
                      <span className="text-xs text-on-surface-tertiary">{gt("Imported")}</span>
                    ) : (
                      <span className="text-xs text-on-surface-tertiary">{gt("Generated")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">{key.ownerName}</td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex gap-2 justify-end">
                      {canLend && ci && ci.viewerUserId === key.userId && !key.isImported ? (
                        ci.sshKeys.some((l) => l.sshKeyId === key.id) ? (
                          <button
                            type="button"
                            onClick={() => void stopLending(key.id)}
                            className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                          >
                            {gt("Stop using in CI jobs ({name})", {
                              name: ci.sshKeys.find((l) => l.sshKeyId === key.id)?.ciName ?? "",
                            })}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setLending(key)}
                            className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                          >
                            {gt("Use in CI jobs")}
                          </button>
                        )
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(key.publicKey);
                        }}
                        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                      >
                        {gt("Copy public key")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(key.id)}
                        className="text-xs text-danger hover:text-danger-strong"
                      >
                        {gt("Delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lending && (
        <LendKeyModal
          sshKey={lending}
          onClose={() => setLending(null)}
          onSaved={() => {
            setLending(null);
            void load();
          }}
        />
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
        <Modal onClose={() => setGeneratedKey(null)} ariaLabel={gt("Key Generated")}>
          <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-lg shadow-2xl p-5">
            <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">
              {gt("Key Generated")}
            </h2>
            <p className="text-xs text-on-surface-tertiary mb-3">
              {gt("Copy the private key now. You won't be able to see it again.")}
            </p>
            <div className="space-y-3">
              <div>
                <span className="block text-xs text-on-surface-muted mb-1">{gt("Public Key")}</span>
                <div className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs text-on-surface-secondary break-all select-all max-h-20 overflow-auto">
                  {generatedKey.publicKey}
                </div>
              </div>
              <div>
                <span className="block text-xs text-on-surface-muted mb-1">
                  {gt("Private Key")}
                </span>
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
              className="mt-3 w-full px-3 py-2 text-sm font-medium bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors"
            >
              {gt("Copy private key to clipboard")}
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
  const { orgId, api } = useSettingsHost();
  const gt = useGT();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      setError(gt("Name is required"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<{
        id: string;
        publicKey: string;
        privateKey: string;
      }>(`/api/org/${orgId}/ssh-keys`, { name: name.trim() });
      onCreated({ publicKey: result.publicKey, privateKey: result.privateKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to generate key"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Generate SSH Key")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Generate SSH Key")}
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
            <label
              id="generate-ssh-key-name-label"
              htmlFor="generate-ssh-key-name"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              {gt("Key name")}
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
            {gt(
              "An Ed25519 keypair will be generated. The private key is only shown once. The public key will be shared with all organization members.",
            )}
          </p>
          {error && <p className="text-xs text-danger">{error}</p>}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving}
            className="w-full px-3 py-2 text-sm font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent rounded-lg transition-colors"
          >
            {saving ? gt("Generating...") : gt("Generate key")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ImportKeyModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { orgId, api } = useSettingsHost();
  const gt = useGT();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    if (!name.trim()) {
      setError(gt("Name is required"));
      return;
    }
    if (!publicKey.trim()) {
      setError(gt("Public key is required"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/org/${orgId}/ssh-keys/import`, {
        name: name.trim(),
        publicKey: publicKey.trim(),
      });
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to import key"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Import SSH Key")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Import SSH Key")}
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
            <label
              id="import-ssh-key-name-label"
              htmlFor="import-ssh-key-name"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              {gt("Key name")}
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
              {gt("Public key")}
            </label>
            <textarea
              id="import-ssh-public-key"
              aria-labelledby="import-ssh-public-key-label"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              // i18n-ignore: SSH public key format example
              placeholder="ssh-ed25519 AAAA... user@host"
              rows={4}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong font-mono resize-none"
            />
          </div>
          <T>
            <p className="text-xs text-on-surface-muted">
              Paste your public key (e.g. from{" "}
              <code className="text-on-surface-tertiary">~/.ssh/id_ed25519.pub</code>). Only the
              public key is stored. The key will be shared with all organization members.
            </p>
          </T>
          {error && <p className="text-xs text-danger">{error}</p>}
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={saving}
            className="w-full px-3 py-2 text-sm font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent rounded-lg transition-colors"
          >
            {saving ? gt("Importing...") : gt("Import key")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Lends one of the caller's own keys to CI jobs: its name in pipelines, and where. */
function LendKeyModal({
  sshKey,
  onClose,
  onSaved,
}: {
  sshKey: SshKey;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { orgId, api } = useSettingsHost();
  const gt = useGT();
  const [ciName, setCiName] = useState(() => ciGrantNameFor(sshKey.name));
  const [repos, setRepos] = useState("");
  const [branchPattern, setBranchPattern] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameOk = CI_GRANT_NAME.test(ciName);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const list = repos
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      await api.put(`/api/org/${orgId}/ci/access/ssh-keys/${sshKey.id}`, {
        enabled: true,
        ciName,
        repos: list.length > 0 ? list : null,
        branchPattern: branchPattern.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not save"));
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary";
  return (
    <Modal onClose={onClose} ariaLabel={gt("Use in CI jobs")}>
      <form
        className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl p-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className="text-sm font-semibold text-on-surface-secondary">
          {gt("Use {name} in CI jobs", { name: sshKey.name })}
        </h2>
        <label className="block text-xs text-on-surface-muted space-y-1">
          <span>{gt("Name in pipelines")}</span>
          <input
            value={ciName}
            onChange={(e) => setCiName(e.target.value)}
            className={`${inputClass} font-mono`}
            aria-invalid={!nameOk}
            autoComplete="off"
          />
        </label>
        <p className="font-mono text-[11px] text-on-surface-faint">{`ssh-keys: [${ciName}]`}</p>
        <label className="block text-xs text-on-surface-muted space-y-1">
          <span>{gt("Repositories (owner/name, separated by commas; empty for every one)")}</span>
          <input
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
            className={`${inputClass} font-mono`}
            autoComplete="off"
          />
        </label>
        <label className="block text-xs text-on-surface-muted space-y-1">
          <span>{gt("Branches (empty for every branch)")}</span>
          <input
            value={branchPattern}
            onChange={(e) => setBranchPattern(e.target.value)}
            // i18n-ignore: branch glob syntax
            placeholder="main, release/*"
            className={`${inputClass} font-mono`}
            autoComplete="off"
          />
        </label>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-on-surface-muted hover:text-on-surface-secondary"
          >
            {gt("Cancel")}
          </button>
          <button
            type="submit"
            disabled={saving || !nameOk}
            className="px-3 py-1.5 text-sm font-medium bg-accent hover:bg-accent-hover text-on-accent rounded-lg disabled:opacity-50"
          >
            {gt("Use in CI jobs")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
