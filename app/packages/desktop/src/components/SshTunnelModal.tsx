import { useState } from "react";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { sshOpenTunnel } from "../lib/ssh-tunnel";
import { useUIStore, Modal } from "@infrawrench/ui";
import { formatErrorMessage } from "../lib/errors";
import { ErrorNotice } from "./ErrorNotice";
import { SshKeyPicker } from "./SshKeyPicker";

const PRESETS = {
  docker:    { label: "Docker",     pluginId: "docker",    port: 2375 },
  postgres:  { label: "PostgreSQL", pluginId: "postgres",  port: 5432 },
  mysql:     { label: "MySQL",      pluginId: "mysql",     port: 3306 },
  redis:     { label: "Redis",      pluginId: "redis",     port: 6379 },
  memcached: { label: "Memcached",  pluginId: "memcached", port: 11211 },
  custom:    { label: "Custom...",  pluginId: null,        port: 0 },
} as const;

type PresetKey = keyof typeof PRESETS;

function buildCredentials(pluginId: string, remotePort: number): Record<string, string> {
  switch (pluginId) {
    case "docker":
      return { dockerHost: `tcp://localhost:${remotePort}` };
    case "postgres":
      return { connectionString: `postgresql://localhost:${remotePort}/postgres` };
    case "mysql":
      return { connectionString: `mysql://localhost:${remotePort}/mysql` };
    case "redis":
      return { connectionString: `redis://localhost:${remotePort}` };
    case "memcached":
      return { connectionString: `memcached://localhost:${remotePort}` };
    default:
      return { host: `localhost:${remotePort}` };
  }
}

interface SshTunnelModalProps {
  sshHost: string;
  sourceAccountId: string;
  onClose: () => void;
  onTunnelEstablished: (newAccountId: string) => void;
}

export function SshTunnelModal({ sshHost, sourceAccountId, onClose, onTunnelEstablished }: SshTunnelModalProps) {
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [privateKey, setPrivateKey] = useState("");
  const [service, setService] = useState<PresetKey>("docker");
  const [customPort, setCustomPort] = useState(22222);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = PRESETS[service];
  const remotePort = service === "custom" ? customPort : preset.port;

  async function onConfirm() {
    if (!privateKey.trim()) { setError("Select an SSH key first"); return; }
    if (service === "custom" && !customPort) { setError("Remote port is required"); return; }
    const pluginId = preset.pluginId;
    if (!pluginId) { setError("Select a service type"); return; }

    setConnecting(true);
    setError(null);
    try {
      const db = await getDb();

      // Encrypt private key
      const { ciphertext, iv } = await invoke<{ ciphertext: string; iv: string }>("encrypt_value", {
        plaintext: privateKey.trim(),
      });

      // Open SSH tunnel to verify credentials + get local port
      const { localPort, tunnelId } = await sshOpenTunnel({
        sshHost,
        sshPort,
        sshUser,
        privateKey: privateKey.trim(),
        remoteHost: "127.0.0.1",
        remotePort,
      });
      void tunnelId; // tunnel stays open; it will be re-established via ssh_tunnel_configs on next connect

      // Create new account with original remote address credentials
      const newAccountId = crypto.randomUUID();
      const credentials = buildCredentials(pluginId, remotePort);
      const { ciphertext: credCiphertext, iv: credIv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: JSON.stringify(credentials) },
      );
      const displayName = `${preset.label} on ${sshHost}`;
      await db.execute(
        "INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv) VALUES ($1, $2, $3, $4, $5)",
        [newAccountId, pluginId, displayName, credCiphertext, credIv],
      );

      // Save SSH tunnel config linked to the new account
      const tunnelId2 = crypto.randomUUID();
      await db.execute(
        `INSERT OR REPLACE INTO ssh_tunnel_configs
         (id, account_id, ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tunnelId2, newAccountId, sshHost, sshPort, sshUser, "127.0.0.1", remotePort, ciphertext, iv],
      );

      void localPort; // tunnel is live; the new account will re-use or re-open it
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
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-gray-800">
          <h2 className="text-base font-semibold text-gray-100">Connect to service via SSH</h2>
          <p className="text-xs text-gray-500 mt-1">SSH host: <span className="text-gray-300 font-mono">{sshHost}</span></p>
        </div>

        <div className="p-6 space-y-4">
          <SshKeyPicker
            username={sshUser}
            onUsernameChange={setSshUser}
            onKeyResolved={setPrivateKey}
          />

          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 w-20 shrink-0">SSH Port</label>
            <input
              type="number"
              value={sshPort}
              onChange={(e) => setSshPort(Number(e.target.value))}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
            />
          </div>

          {/* Service selector */}
          <div>
            <label className="block text-xs text-gray-500 mb-2">Target Service</label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.entries(PRESETS) as [PresetKey, typeof PRESETS[PresetKey]][]).map(([key, p]) => (
                <button
                  key={key}
                  onClick={() => setService(key)}
                  className={`px-3 py-2 rounded-lg text-xs border transition-colors ${
                    service === key
                      ? "border-blue-500 bg-blue-500/10 text-blue-300"
                      : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600 hover:text-gray-200"
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
                  {key !== "custom" && <div className="text-gray-500 mt-0.5">:{p.port}</div>}
                </button>
              ))}
            </div>
          </div>

          {service === "custom" && (
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-500 w-20 shrink-0">Remote Port</label>
              <input
                type="number"
                value={customPort}
                onChange={(e) => setCustomPort(Number(e.target.value))}
                className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
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

        <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={connecting}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void onConfirm()}
            disabled={connecting || !privateKey.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
