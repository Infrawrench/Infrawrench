import { useState, useEffect } from "react";
import { Modal } from "../components/Modal.js";
import type { Bastion } from "../api-types.js";
import { useSettingsHost } from "./host.js";

interface CreatedBastion {
  id: string;
  name: string;
  token: string;
  tokenPrefix: string;
}

export function BastionsSection() {
  const { orgId, api } = useSettingsHost();
  const [bastions, setBastions] = useState<Bastion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createdBastion, setCreatedBastion] = useState<CreatedBastion | null>(null);

  async function load() {
    setLoading(true);
    const result = await api.get<Bastion[]>(`/api/org/${orgId}/bastions`);
    setBastions(result);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // Connected status is live — poll every 10s so the badge actually changes
    // when the user starts/stops the agent in another window.
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDelete(id: string) {
    if (
      !confirm("Revoke this bastion? Accounts that route through it will revert to direct egress.")
    )
      return;
    await api.delete(`/api/org/${orgId}/bastions/${id}`);
    await load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Bastions</h1>
          <p className="text-sm text-on-surface-muted mt-1">
            Outbound proxy agents you run on your own infrastructure. Bind an account to a bastion
            to make its cloud-API traffic exit from your IP, for source-IP allowlists or private
            networks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          New Bastion
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : bastions.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No bastions registered. Click <strong>New Bastion</strong> to create one; you&apos;ll be
          handed a <code>docker run</code> command to start the agent.
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
                  Status
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Accounts
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Agent
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Last seen
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Token
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {bastions.map((b) => (
                <tr key={b.id} className="border-b border-border/50 hover:bg-surface-raised/50">
                  <td className="px-4 py-2 text-sm text-on-surface-secondary">{b.name}</td>
                  <td className="px-4 py-2">
                    <StatusBadge bastion={b} />
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary">{b.accountCount}</td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono">
                    {b.agentVersion ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">
                    {b.lastSeenAt ? new Date(b.lastSeenAt).toLocaleString() : "never"}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary font-mono">
                    {b.tokenPrefix}…
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void handleDelete(b.id)}
                      className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateBastionModal
          onClose={() => setShowCreate(false)}
          onCreated={(b) => {
            setCreatedBastion(b);
            setShowCreate(false);
            void load();
          }}
        />
      )}

      {createdBastion && (
        <CreatedBastionModal bastion={createdBastion} onClose={() => setCreatedBastion(null)} />
      )}
    </div>
  );
}

function StatusBadge({ bastion }: { bastion: Bastion }) {
  if (bastion.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="size-1.5 rounded-full bg-green-500" />
        <span className="text-on-surface-secondary">Connected</span>
      </span>
    );
  }
  if (bastion.status === "pending" && !bastion.lastSeenAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="size-1.5 rounded-full bg-amber-500" />
        <span className="text-on-surface-tertiary">Awaiting first connect</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="size-1.5 rounded-full bg-red-500" />
      <span className="text-on-surface-tertiary">Offline</span>
    </span>
  );
}

function CreateBastionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (b: CreatedBastion) => void;
}) {
  const { orgId, api } = useSettingsHost();
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
      const result = await api.post<CreatedBastion>(`/api/org/${orgId}/bastions`, {
        name: name.trim(),
      });
      onCreated(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create bastion");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel="Register a bastion">
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Register a bastion</h2>
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
              id="bastion-name-label"
              htmlFor="bastion-name"
              className="block text-xs text-on-surface-tertiary mb-1"
            >
              Name
            </label>
            <input
              id="bastion-name"
              aria-labelledby="bastion-name-label"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="prod-egress-eu-west-1"
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
            />
          </div>
          <p className="text-xs text-on-surface-muted">
            You&apos;ll receive a one-time enrollment token and a <code>docker run</code> command to
            start the agent container on your infrastructure. The token cannot be retrieved again;
            copy it then.
          </p>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving}
            className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {saving ? "Creating..." : "Create bastion"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CreatedBastionModal({
  bastion,
  onClose,
}: {
  bastion: CreatedBastion;
  onClose: () => void;
}) {
  const { cloudOrigin } = useSettingsHost();
  // Resolve a backend URL that the user's host can actually reach. We can't
  // assume same-origin for the agent — typically the agent runs on a VM
  // somewhere else. The desktop host passes its cloud origin (the app shell
  // itself isn't a reachable server); web defaults to the current origin for
  // "they're running this locally" demos, and in production the user replaces
  // it with the public host.
  const wsUrl = (() => {
    if (cloudOrigin) {
      return `${cloudOrigin.replace(/^http/, "ws")}/api/bastions/agent`;
    }
    if (typeof window === "undefined") return "wss://app.infrawrench.com/api/bastions/agent";
    const loc = window.location;
    const scheme = loc.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${loc.host}/api/bastions/agent`;
  })();
  const dockerRun = `docker run -d \\
  --name infrawrench-bastion \\
  --restart unless-stopped \\
  -e BASTION_TOKEN=${bastion.token} \\
  -e INFRAWRENCH_URL=${wsUrl} \\
  registry.infrawrench.com/bastion-agent:latest`;

  return (
    <Modal onClose={onClose} ariaLabel="Bastion created: start the agent">
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-2xl shadow-2xl p-5">
        <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">
          Bastion created: start the agent
        </h2>
        <p className="text-xs text-on-surface-tertiary mb-3">
          Copy the command below and run it on any Docker host. The bastion will appear as
          <span className="text-green-500"> Connected </span>
          once the agent dials in. The token is shown only this once.
        </p>
        <span className="block text-xs text-on-surface-muted mb-1">Run command</span>
        <div className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs text-on-surface-secondary break-all select-all max-h-40 overflow-auto whitespace-pre">
          {dockerRun}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(dockerRun);
          }}
          className="mt-3 w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Copy command to clipboard
        </button>
        <div className="mt-4 text-xs text-on-surface-muted space-y-1">
          <p>
            <strong className="text-on-surface-tertiary">Next:</strong> When adding a cloud account,
            pick this bastion in the &quot;Egress via&quot; dropdown. All control-plane API calls
            for that account will route through the agent.
          </p>
        </div>
      </div>
    </Modal>
  );
}
