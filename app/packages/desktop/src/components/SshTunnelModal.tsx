import { useEffect, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { cloudSshTunnelCreateAccount } from "../lib/cloud-sftp";
import { getDb } from "../db/client";
import {
  openPlainTunnel,
  plainTunnelProblem,
  sshCloseTunnel,
  sshOpenTunnel,
} from "../lib/ssh-tunnel";
import { loadPlugins } from "../plugins/loader";
import {
  useUIStore,
  Modal,
  formatErrorMessage,
  sshTunnelPresets,
  buildSshTunnelCredentials,
  toast,
  useDataString,
  type SshTunnelPreset,
} from "@infrawrench/ui";
import { ErrorNotice } from "./ErrorNotice";
import { SshKeyPicker } from "./SshKeyPicker";
import type { KeySource } from "../lib/ssh-key-source";
import { createLocalAccount } from "../lib/local-credentials";
import { encryptTunnelConfigKey } from "../lib/local-secrets";

interface SshTunnelModalProps {
  sshHost: string;
  defaultUsername?: string;
  sourceAccountId: string;
  /** The id of the plugin to preselect. Defaults to the first preset. */
  defaultService?: string;
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
  const gt = useGT();
  const gtData = useDataString();
  const [sshUser, setSshUser] = useState(defaultUsername ?? "root");
  const [sshPort, setSshPort] = useState(22);
  const [privateKey, setPrivateKey] = useState("");
  const [keySource, setKeySource] = useState<KeySource | null>(null);
  const [presets, setPresets] = useState<SshTunnelPreset[]>([]);
  const [service, setService] = useState(defaultService);
  const [customPort, setCustomPort] = useState(22222);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  // A plain tunnel has no account to find it by later, so it lives as long as this modal.
  const [plainTunnel, setPlainTunnel] = useState<{ tunnelId: string; localPort: number } | null>(
    null,
  );
  const plainTunnelId = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (plainTunnelId.current) void sshCloseTunnel(plainTunnelId.current).catch(() => {});
    },
    [],
  );

  const preset = presets.find((p) => p.key === service) ?? presets[0];
  const isCustom = preset?.pluginId === null;
  const remotePort = isCustom ? customPort : (preset?.port ?? 0);

  useEffect(() => {
    loadPlugins()
      .then((loaded) =>
        setPresets(
          sshTunnelPresets(
            loaded.map(({ plugin }) => ({
              id: plugin.manifest.id,
              sshTunnel: plugin.manifest.sshTunnel,
            })),
            { custom: true },
          ),
        ),
      )
      .catch((err) => {
        setPresets(sshTunnelPresets([], { custom: true }));
        toast.error(gt("Failed to load services"), { description: formatErrorMessage(err) });
      });
  }, []);

  async function onConfirm() {
    const isCloudKey = keySource?.type === "cloud";
    if (!isCloudKey && !privateKey.trim()) {
      setError(gt("Select an SSH key first"));
      return;
    }
    if (!keySource) {
      setError(gt("Select an SSH key first"));
      return;
    }
    const problem = isCustom ? plainTunnelProblem(customPort, keySource.type) : null;
    if (problem === "port") {
      setError(gt("Enter a remote port from 1 to 65535"));
      return;
    }
    if (problem === "cloud-key") {
      setError(
        gt(
          "A custom tunnel runs on this computer, and an organization key stays on the server. Pick a key stored here.",
        ),
      );
      return;
    }
    if (!preset) {
      setError(gt("Select a service type"));
      return;
    }
    const pluginId = preset.pluginId;

    setConnecting(true);
    setError(null);
    try {
      if (pluginId === null) {
        const opened = await openPlainTunnel({
          sshHost,
          sshPort,
          sshUser,
          privateKey: privateKey.trim(),
          remotePort,
        });
        plainTunnelId.current = opened.tunnelId;
        setPlainTunnel(opened);
        return;
      }

      if (activeCloudOrgId && isCloudKey) {
        const displayName = `${preset.label} on ${sshHost}`;
        const credentials = buildSshTunnelCredentials(preset, remotePort);
        const resp = await cloudSshTunnelCreateAccount(activeCloudOrgId, {
          sshHost,
          sshPort,
          sshUser,
          sshKeyId: keySource.sshKeyId,
          remoteHost: "127.0.0.1",
          remotePort,
          pluginId,
          displayName,
          credentials,
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
      const credentials = buildSshTunnelCredentials(preset, remotePort);
      const displayName = `${preset.label} on ${sshHost}`;
      await createLocalAccount({
        accountId: newAccountId,
        pluginId,
        displayName,
        credentials,
      });

      const tunnelId2 = crypto.randomUUID();
      const { ciphertext, iv } = await encryptTunnelConfigKey(tunnelId2, privateKey.trim());
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

  if (plainTunnel) {
    const address = `127.0.0.1:${plainTunnel.localPort}`;
    return (
      <Modal onClose={onClose} ariaLabel={gt("SSH tunnel open")}>
        <div className="bg-surface-raised border border-border-strong rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-auto">
          <div className="p-6 border-b border-border">
            <h2 className="text-base font-semibold text-on-surface">{gt("SSH tunnel open")}</h2>
            <p className="text-xs text-on-surface-muted mt-1">
              {gt(
                "Forwarding to port {port} on {host}. Point a local tool at this address. The tunnel closes with this window.",
                { port: String(remotePort), host: sshHost },
              )}
            </p>
          </div>
          <div className="p-6">
            <input
              readOnly
              value={address}
              aria-label={gt("Local tunnel address")}
              onFocus={(e) => e.target.select()}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
            />
          </div>
          <div className="p-6 border-t border-border flex justify-end gap-3">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(address)
                  .then(() => toast.success(gt("Copied")))
                  .catch((err: unknown) => toast.error(formatErrorMessage(err)))
              }
              className="px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
            >
              {gt("Copy address")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors"
            >
              {gt("Close tunnel")}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
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
              {gt("SSH Port")}
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
            <span className="block text-xs text-on-surface-muted mb-2">{gt("Target Service")}</span>
            <div className="grid grid-cols-3 gap-2">
              {presets.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  onClick={() => setService(p.key)}
                  className={`px-3 py-2 rounded-lg text-xs border transition-colors ${
                    preset?.key === p.key
                      ? "border-accent bg-accent-muted text-accent-on-muted"
                      : "border-border-strong bg-surface-overlay text-on-surface-tertiary hover:border-border-strong hover:text-on-surface-secondary"
                  }`}
                >
                  <div className="font-medium">
                    {p.pluginId === null ? gt("Custom…") : gtData(p.label)}
                  </div>
                  {p.pluginId !== null && (
                    <div className="text-on-surface-muted mt-0.5">:{p.port}</div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {isCustom && (
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
            <ErrorNotice
              message={error}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
              textClassName="text-xs text-danger"
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
            {gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={
              connecting || (keySource?.type !== "cloud" && !privateKey.trim()) || !keySource
            }
            className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors disabled:opacity-50"
          >
            {connecting ? gt("Connecting...") : gt("Connect")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
