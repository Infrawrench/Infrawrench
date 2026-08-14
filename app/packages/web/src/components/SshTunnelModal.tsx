import { useState, useEffect } from "react";
import { T, Var, useGT } from "gt-react";
import {
  Modal,
  useUIStore,
  formatErrorMessage,
  deriveSSHUsername,
  toast,
  useDataString,
  SSH_TUNNEL_PRESETS,
  buildSshTunnelCredentials,
  SshKeyRadioGroup,
  type SshTunnelPresetKey,
} from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";
import type { SshKey } from "@/lib/api-types";
import { useOrgId } from "@/lib/useOrgId";
import { useHostKeyTrust } from "@/lib/useHostKeyTrust";

type PresetKey = SshTunnelPresetKey;

interface SshTunnelModalProps {
  sshHost: string;
  defaultUsername?: string | undefined;
  defaultService?: PresetKey | undefined;
  onClose: () => void;
  onTunnelEstablished: (newAccountId: string) => void;
}

export function SshTunnelModal({
  sshHost,
  defaultUsername,
  defaultService,
  onClose,
  onTunnelEstablished,
}: SshTunnelModalProps) {
  const gt = useGT();
  const gtData = useDataString();
  const orgId = useOrgId();
  const { withTrustPrompt, dialog: hostKeyDialog } = useHostKeyTrust(orgId);
  const [sshUser, setSshUser] = useState(defaultUsername ?? "root");
  const [sshPort, setSshPort] = useState(22);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [service, setService] = useState<PresetKey>(defaultService ?? "docker");
  const [customPort, setCustomPort] = useState(22222);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = SSH_TUNNEL_PRESETS[service];
  const remotePort = service === "custom" ? customPort : preset.port;

  useEffect(() => {
    apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`)
      .then((result) => {
        setKeys(result);
        if (result.length > 0) {
          setSelectedKeyId(result[0]!.id);
          if (!defaultUsername && result[0]!.ownerName) {
            setSshUser(deriveSSHUsername(result[0]!.ownerName));
          }
        }
      })
      .catch((err) =>
        toast.error(gt("Couldn't load SSH keys: {message}", { message: formatErrorMessage(err) })),
      )
      .finally(() => setLoadingKeys(false));
  }, []);

  async function onConfirm() {
    if (!selectedKeyId) {
      setError(gt("Select an SSH key first"));
      return;
    }
    const pluginId = preset.pluginId;
    if (!pluginId) {
      setError(gt("Select a service type"));
      return;
    }
    if (service === "custom" && !customPort) {
      setError(gt("Remote port is required"));
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      const credentials = buildSshTunnelCredentials(pluginId, remotePort);
      const displayName = `${preset.label} on ${sshHost}`;

      const result = await withTrustPrompt(() =>
        apiPost<{ accountId: string }>(`/api/org/${orgId}/ssh-tunnels/create-account`, {
          sshHost,
          sshPort,
          sshUser,
          sshKeyId: selectedKeyId,
          remoteHost: "127.0.0.1",
          remotePort,
          pluginId,
          displayName,
          credentials,
        }),
      );

      useUIStore.getState().bumpAccounts();
      onTunnelEstablished(result.accountId);
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <>
      {hostKeyDialog}
      <Modal onClose={onClose} ariaLabel={gt("Connect to service via SSH")}>
        <div className="bg-surface-raised border border-border-strong rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-auto">
          <div className="p-6 border-b border-border">
            <h2 className="text-base font-semibold text-on-surface">
              {gt("Connect to service via SSH")}
            </h2>
            <T>
              <p className="text-xs text-on-surface-muted mt-1">
                SSH host:{" "}
                <Var>
                  <span className="text-on-surface-secondary font-mono">{sshHost}</span>
                </Var>
              </p>
            </T>
          </div>

          <div className="p-6 space-y-4">
            {/* SSH Key picker */}
            <div className="flex items-start gap-3">
              <span className="text-xs text-on-surface-muted w-20 shrink-0 pt-1">
                {gt("SSH Key")}
              </span>
              <div className="flex-1 space-y-1">
                {loadingKeys ? (
                  <p className="text-xs text-on-surface-faint py-1">{gt("Loading keys…")}</p>
                ) : keys.length === 0 ? (
                  <T>
                    <p className="text-xs text-on-surface-faint py-1">
                      No SSH keys found. Go to Settings to create one.
                    </p>
                  </T>
                ) : (
                  <SshKeyRadioGroup
                    ariaLabel={gt("SSH Key")}
                    selectedId={selectedKeyId}
                    onChange={(id) => {
                      setSelectedKeyId(id);
                      const k = keys.find((x) => x.id === id);
                      if (!defaultUsername && k?.ownerName) {
                        setSshUser(deriveSSHUsername(k.ownerName));
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

            {/* Username */}
            <div className="flex items-center gap-3">
              <label
                id="ssh-tunnel-username-label"
                htmlFor="ssh-tunnel-username"
                className="text-xs text-on-surface-muted w-20 shrink-0"
              >
                {gt("Username")}
              </label>
              <input
                id="ssh-tunnel-username"
                aria-labelledby="ssh-tunnel-username-label"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
                placeholder="root"
                spellCheck={false}
              />
            </div>

            {/* SSH Port */}
            <div className="flex items-center gap-3">
              <label
                id="ssh-tunnel-port-label"
                htmlFor="ssh-tunnel-port"
                className="text-xs text-on-surface-muted w-20 shrink-0"
              >
                {gt("SSH Port")}
              </label>
              <input
                id="ssh-tunnel-port"
                aria-labelledby="ssh-tunnel-port-label"
                type="number"
                value={sshPort}
                onChange={(e) => setSshPort(Number(e.target.value))}
                className="w-24 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
              />
            </div>

            {/* Service selector */}
            <div>
              <span className="block text-xs text-on-surface-muted mb-2">
                {gt("Target Service")}
              </span>
              <div className="grid grid-cols-3 gap-2">
                {(
                  Object.entries(SSH_TUNNEL_PRESETS) as [
                    PresetKey,
                    (typeof SSH_TUNNEL_PRESETS)[PresetKey],
                  ][]
                ).map(([key, p]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setService(key)}
                    className={`px-3 py-2 rounded-lg text-xs border transition-colors ${
                      service === key
                        ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                        : "border-border-strong bg-surface-overlay text-on-surface-tertiary hover:border-border-strong hover:text-on-surface-secondary"
                    }`}
                  >
                    <div className="font-medium">{gtData(p.label)}</div>
                    {key !== "custom" && (
                      <div className="text-on-surface-muted mt-0.5">:{p.port}</div>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {service === "custom" && (
              <div className="flex items-center gap-3">
                <label
                  id="ssh-tunnel-remote-port-label"
                  htmlFor="ssh-tunnel-remote-port"
                  className="text-xs text-on-surface-muted w-20 shrink-0"
                >
                  {gt("Remote Port")}
                </label>
                <input
                  id="ssh-tunnel-remote-port"
                  aria-labelledby="ssh-tunnel-remote-port-label"
                  type="number"
                  value={customPort}
                  onChange={(e) => setCustomPort(Number(e.target.value))}
                  className="w-24 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
                />
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                <p className="text-xs text-danger">{error}</p>
              </div>
            )}
          </div>

          <div className="p-6 border-t border-border flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={connecting}
              className="px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              disabled={connecting || !selectedKeyId}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {connecting ? gt("Connecting...") : gt("Connect")}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
