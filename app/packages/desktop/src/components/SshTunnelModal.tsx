import { useState } from "react";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { sshOpenTunnel } from "../lib/ssh-tunnel";
import {
  useUIStore,
  Modal,
  formatErrorMessage,
  SSH_TUNNEL_PRESETS,
  buildSshTunnelCredentials,
  type SshTunnelPresetKey,
} from "@infrawrench/ui";
import { ErrorNotice } from "./ErrorNotice";
import { SshKeyPicker } from "./SshKeyPicker";
import type { KeySource } from "../lib/ssh-key-source";

export type PresetKey = SshTunnelPresetKey;

interface SshTunnelModalProps {
  sshHost: string;
  defaultUsername?: string;
  sourceAccountId: string;
  defaultService?: PresetKey;
  onClose: () => void;
  onTunnelEstablished: (newAccountId: string) => void;
}

export function SshTunnelModal({
  sshHost,
  defaultUsername,
  sourceAccountId,
  defaultService,
  onClose,
  onTunnelEstablished,
}: SshTunnelModalProps) {
  const [sshUser, setSshUser] = useState(defaultUsername ?? "root");
  const [sshPort, setSshPort] = useState(22);
  const [privateKey, setPrivateKey] = useState("");
  const [keySource, setKeySource] = useState<KeySource | null>(null);
  const [service, setService] = useState<PresetKey>(defaultService ?? "docker");
  const [customPort, setCustomPort] = useState(22222);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  const preset = SSH_TUNNEL_PRESETS[service];
  const remotePort = service === "custom" ? customPort : preset.port;

  async function onConfirm() {
    const isCloudKey = keySource?.type === "cloud";
    if (!isCloudKey && !privateKey.trim()) {
      setError("Select an SSH key first");
      return;
    }
    if (!keySource) {
      setError("Select an SSH key first");
      return;
    }
    if (service === "custom" && !customPort) {
      setError("Remote port is required");
      return;
    }
    const pluginId = preset.pluginId;
    if (!pluginId) {
      setError("Select a service type");
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      if (activeCloudOrgId && isCloudKey) {
        const displayName = `${preset.label} on ${sshHost}`;
        const credentials = buildSshTunnelCredentials(pluginId, remotePort);
        const resp = await invoke<{ accountId: string }>("cloud_ssh_tunnel_create_account", {
          orgId: activeCloudOrgId,
          body: {
            sshHost,
            sshPort,
            sshUser,
            sshKeyId: keySource.sshKeyId,
            remoteHost: "127.0.0.1",
            remotePort,
            pluginId,
            displayName,
            credentials,
          },
        });
        useUIStore.getState().bumpAccounts();
        onTunnelEstablished(resp.accountId);
        return;
      }

      const db = await getDb();

      // Open tunnel to verify credentials; it stays open and will be re-established via ssh_tunnel_configs on reconnect
      await sshOpenTunnel({
        sshHost,
        sshPort,
        sshUser,
        privateKey: privateKey.trim(),
        remoteHost: "127.0.0.1",
        remotePort,
      });

      const newAccountId = crypto.randomUUID();
      const credentials = buildSshTunnelCredentials(pluginId, remotePort);
      const displayName = `${preset.label} on ${sshHost}`;
      await invoke<void>("account_create", {
        accountId: newAccountId,
        pluginId,
        displayName,
        credentials,
      });

      const tunnelId2 = crypto.randomUUID();
      const { ciphertext, iv } = await invoke<{ ciphertext: string; iv: string }>(
        "ssh_tunnel_config_encrypt_private_key",
        { tunnelConfigId: tunnelId2, privateKey: privateKey.trim() },
      );
      await db.execute(
        `INSERT OR REPLACE INTO ssh_tunnel_configs
         (id, account_id, ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tunnelId2,
          newAccountId,
          sshHost,
          sshPort,
          sshUser,
          "127.0.0.1",
          remotePort,
          ciphertext,
          iv,
        ],
      );

      useUIStore.getState().bumpAccounts();
      onTunnelEstablished(newAccountId);
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-border">
          <h2 className="text-base font-semibold text-on-surface">Connect to service via SSH</h2>
          <p className="text-xs text-on-surface-muted mt-1">
            SSH host: <span className="text-on-surface-secondary font-mono">{sshHost}</span>
          </p>
        </div>

        <div className="p-6 space-y-4">
          <SshKeyPicker
            username={sshUser}
            onUsernameChange={setSshUser}
            onKeyResolved={setPrivateKey}
            selectedKeyRef={setKeySource}
          />

          <div className="flex items-center gap-3">
            <label
              id="ssh-tunnel-ssh-port-label"
              htmlFor="ssh-tunnel-ssh-port"
              className="text-xs text-on-surface-muted w-20 shrink-0"
            >
              SSH Port
            </label>
            <input
              id="ssh-tunnel-ssh-port"
              aria-labelledby="ssh-tunnel-ssh-port-label"
              type="number"
              value={sshPort}
              onChange={(e) => setSshPort(Number(e.target.value))}
              className="w-24 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
            />
          </div>

          {/* Service selector */}
          <div>
            <span className="block text-xs text-on-surface-muted mb-2">Target Service</span>
            <div className="grid grid-cols-3 gap-2">
              {(
                Object.entries(SSH_TUNNEL_PRESETS) as [
                  PresetKey,
                  (typeof SSH_TUNNEL_PRESETS)[PresetKey],
                ][]
              ).map(([key, p]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setService(key)}
                  className={`px-3 py-2 rounded-lg text-xs border transition-colors ${
                    service === key
                      ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                      : "border-border-strong bg-surface-overlay text-on-surface-tertiary hover:border-border-strong hover:text-on-surface-secondary"
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
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
                Remote Port
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
            <ErrorNotice
              message={error}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
              textClassName="text-xs text-red-400"
            />
          )}
        </div>

        <div className="p-6 border-t border-border flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={connecting}
            className="px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={
              connecting || (keySource?.type !== "cloud" && !privateKey.trim()) || !keySource
            }
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
