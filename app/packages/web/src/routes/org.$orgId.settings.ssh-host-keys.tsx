import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Modal } from "@infrawrench/ui";
import { apiGet, apiDelete } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId/settings/ssh-host-keys")({
  component: SshHostKeysPage,
});

interface HostKeyPin {
  id: string;
  host: string;
  port: number;
  fingerprint: string;
  createdAt: string;
}

function SshHostKeysPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/ssh-host-keys" });
  const [pins, setPins] = useState<HostKeyPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await apiGet<{ pins: HostKeyPin[] }>(`/api/org/${orgId}/ssh-host-keys`);
      setPins(result.pins);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trusted host keys");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleDelete(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      await apiDelete(`/api/org/${orgId}/ssh-host-keys/${id}`);
      setConfirmId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove pin");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Trusted SSH Hosts</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          SSH server fingerprints your organization has trusted. The next connection to a removed
          host will prompt for re-verification.
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-red-400 border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : pins.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No SSH hosts trusted yet. The first time you connect to a host, you&apos;ll be asked to
          verify its fingerprint; the trusted pin will appear here.
        </p>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Host
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Port
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Fingerprint
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Trusted
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {pins.map((pin) => (
                <tr key={pin.id} className="border-b border-border/50 hover:bg-surface-raised/50">
                  <td className="px-4 py-2 text-sm text-on-surface-secondary font-mono">
                    {pin.host}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono">
                    {pin.port}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono truncate max-w-[420px]">
                    {pin.fingerprint}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">
                    {new Date(pin.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex gap-3 justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(pin.fingerprint);
                        }}
                        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                      >
                        Copy fingerprint
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(pin.id)}
                        disabled={deletingId === pin.id}
                        className="text-xs text-red-400 hover:text-red-500 dark:text-red-300 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmId && (
        <RevokePinConfirm
          pin={pins.find((p) => p.id === confirmId)!}
          submitting={deletingId === confirmId}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => void handleDelete(confirmId)}
        />
      )}
    </div>
  );
}

function RevokePinConfirm({
  pin,
  submitting,
  onCancel,
  onConfirm,
}: {
  pin: HostKeyPin;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      onClose={() => {
        if (!submitting) onCancel();
      }}
    >
      <div className="bg-surface-raised border border-border-strong rounded-xl w-[min(28rem,92vw)] shadow-2xl">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Revoke trusted host</h2>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-sm text-on-surface-tertiary">
            The next connection to{" "}
            <span className="font-mono text-on-surface-secondary">
              {pin.host}:{pin.port}
            </span>{" "}
            will prompt for fingerprint re-verification.
          </p>
          <div>
            <div className="text-xs text-on-surface-muted mb-1">Currently trusted fingerprint</div>
            <div className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs text-on-surface-secondary break-all select-all">
              {pin.fingerprint}
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={submitting}
              className="px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {submitting ? "Revoking..." : "Revoke pin"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
