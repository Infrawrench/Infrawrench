import { useEffect, useState } from "react";
import { Modal } from "@infrawrench/ui";
import { apiGet } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import type { AccountListItem } from "@/lib/api-types";
import { AddAccountModal } from "./AddAccountModal";

interface Props {
  /** Source resource's displayName, used to suggest the new SSH account name. */
  sourceDisplayName: string;
  /** Public/external host for the source resource (always present when this dialog is shown). */
  publicHost: string;
  /** Private/internal host if the resource type declares `privateHostOutputKey`. */
  privateHost?: string | undefined;
  /** Username to seed the new SSH account with. */
  defaultUsername?: string | undefined;
  /** Optional source SSH port; defaults to 22. */
  port?: number | undefined;
  onClose: () => void;
  onAdded: () => void;
}

/**
 * Two-step "Connect through jumpbox" dialog:
 *   1. Pick an existing SSH plugin account (the jumpbox) and which IP of the
 *      source resource to dial through it.
 *   2. Hand off to AddAccountModal pre-filled with the snapshotted host/user/port
 *      and the chosen `connectThroughAccountId`, so the user only has to enter
 *      the private key (or create the account first if no jumpboxes exist).
 *
 * The user picks the SSH key (or pastes a private key) in step 2 just like any
 * other SSH account — there is no separate key-picker here.
 */
export function ConnectThroughJumpboxDialog({
  sourceDisplayName,
  publicHost,
  privateHost,
  defaultUsername,
  port,
  onClose,
  onAdded,
}: Props) {
  const orgId = useOrgId();
  const [sshAccounts, setSshAccounts] = useState<AccountListItem[] | null>(null);
  const [jumpboxId, setJumpboxId] = useState<string>("");
  const [useAddress, setUseAddress] = useState<"public" | "private">(
    privateHost ? "private" : "public",
  );
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [name, setName] = useState(`${sourceDisplayName} via jumpbox`);

  useEffect(() => {
    apiGet<AccountListItem[]>(`/api/org/${orgId}/accounts`)
      .then((rows) => setSshAccounts(rows.filter((r) => r.pluginId === "ssh")))
      .catch(() => setSshAccounts([]));
  }, [orgId]);

  if (showAddAccount) {
    const chosenHost = useAddress === "private" && privateHost ? privateHost : publicHost;
    return (
      <AddAccountModal
        onClose={onClose}
        onAdded={onAdded}
        prefilledPluginId="ssh"
        prefilledDisplayName={name.trim() || sourceDisplayName}
        prefilledCredentials={{
          host: chosenHost,
          port: String(port ?? 22),
          username: defaultUsername || "root",
          connectThroughAccountId: jumpboxId,
        }}
      />
    );
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            Connect through jumpbox
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg leading-none"
            aria-label="Close"
          >
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-on-surface-faint">
            Creates a new SSH target that routes through the selected jumpbox. The jumpbox itself
            can also be configured to route through another SSH account, allowing multi-hop chains.
          </p>

          <div>
            <label htmlFor="ctj-name" className="block text-xs text-on-surface-tertiary mb-1">
              New SSH account name
            </label>
            <input
              id="ctj-name"
              type="text"
              aria-label="New SSH account name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary focus:outline-none focus:border-border-strong"
            />
          </div>

          <div>
            <label htmlFor="ctj-jumpbox" className="block text-xs text-on-surface-tertiary mb-1">
              Jumpbox
            </label>
            {sshAccounts === null ? (
              <p className="text-xs text-on-surface-faint">Loading…</p>
            ) : sshAccounts.length === 0 ? (
              <p className="text-xs text-on-surface-faint">
                No SSH accounts yet. Add one from the sidebar first; that account becomes the
                jumpbox.
              </p>
            ) : (
              <select
                id="ctj-jumpbox"
                value={jumpboxId}
                onChange={(e) => setJumpboxId(e.target.value)}
                className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary focus:outline-none focus:border-border-strong"
              >
                <option value="">Select jumpbox…</option>
                {sshAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>

          {privateHost && (
            <div>
              <div className="block text-xs text-on-surface-tertiary mb-1">
                Connect to {sourceDisplayName} via
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                  <input
                    type="radio"
                    name="ctj-address"
                    aria-label={`Private address (${privateHost})`}
                    checked={useAddress === "private"}
                    onChange={() => setUseAddress("private")}
                  />
                  <span>
                    Private address (<span className="font-mono">{privateHost}</span>)
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                  <input
                    type="radio"
                    name="ctj-address"
                    aria-label={`Public address (${publicHost})`}
                    checked={useAddress === "public"}
                    onChange={() => setUseAddress("public")}
                  />
                  <span>
                    Public address (<span className="font-mono">{publicHost}</span>)
                  </span>
                </label>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary border border-border-strong rounded-lg hover:border-border-strong transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setShowAddAccount(true)}
              disabled={!jumpboxId || !name.trim()}
              className="flex-1 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              Add account
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
