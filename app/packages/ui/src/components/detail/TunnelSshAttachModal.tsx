import { useId, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { Modal } from "../Modal.js";
import { ErrorNotice } from "../ErrorNotice.js";

export interface TunnelSshAttachStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface TunnelSshAttachResult {
  steps: TunnelSshAttachStep[];
  /** Final client-side connect command to show the user. */
  connectCommand?: string;
}

export interface TunnelSshAttachZone {
  id: string;
  label: string;
}

export interface TunnelSshAttachKey {
  id: string;
  label: string;
}

export type TunnelServiceType = "http" | "https" | "ssh" | "tcp";

const SERVICE_OPTIONS: { id: TunnelServiceType; label: string; defaultPort: string }[] = [
  { id: "http", label: "HTTP", defaultPort: "80" },
  { id: "https", label: "HTTPS", defaultPort: "443" },
  { id: "ssh", label: "SSH", defaultPort: "22" },
  { id: "tcp", label: "TCP", defaultPort: "" },
];

export interface TunnelSshAttachModalProps {
  tunnelName: string;
  hostName: string;
  /** CF zones in the tunnel's account — the hostname's parent zone. */
  zones: TunnelSshAttachZone[];
  /** SSH keys to authenticate the install (web/org keystore). Empty on desktop (agent-based). */
  sshKeys: TunnelSshAttachKey[];
  /** When false, hide the SSH key picker (desktop uses the local agent/1Password). */
  showSshKeyPicker: boolean;
  /** Prefilled SSH username derived from the host's sshEndpoint. */
  defaultUsername: string;
  onRun: (params: {
    hostname: string;
    zoneId: string;
    serviceType: TunnelServiceType;
    port: string;
    sshUsername: string;
    sshKeyId?: string;
  }) => Promise<TunnelSshAttachResult>;
  onClose: () => void;
}

const inputClass =
  "w-full px-3 py-2 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500";

/**
 * Confirm + run the "set up SSH over a Cloudflare Tunnel" flow: point the
 * tunnel's ingress at the host's SSH, create the routing DNS record, then SSH
 * into the host and install/run cloudflared. The install script is shown for
 * transparency; the user clicks Run.
 */
export function TunnelSshAttachModal({
  tunnelName,
  hostName,
  zones,
  sshKeys,
  showSshKeyPicker,
  defaultUsername,
  onRun,
  onClose,
}: TunnelSshAttachModalProps) {
  const gt = useGT();
  const [hostname, setHostname] = useState("");
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? "");
  const [serviceType, setServiceType] = useState<TunnelServiceType>("ssh");
  const [port, setPort] = useState("22");
  const [sshUsername, setSshUsername] = useState(defaultUsername);
  const [sshKeyId, setSshKeyId] = useState(sshKeys[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TunnelSshAttachResult | null>(null);
  const sshUsernameId = useId();

  // Switching service resets the port to that service's default.
  const onServiceChange = (next: TunnelServiceType) => {
    setServiceType(next);
    setPort(SERVICE_OPTIONS.find((s) => s.id === next)?.defaultPort ?? "");
  };

  const scriptPreview = useMemo(
    () =>
      [
        "# On the host (run via SSH):",
        "curl -fsSL -o cloudflared … (arch-detected .deb or binary)",
        "sudo dpkg -i cloudflared.deb   # or install the binary",
        "sudo cloudflared service install <TUNNEL_TOKEN>",
      ].join("\n"),
    [],
  );

  const canRun =
    hostname.trim().length > 0 &&
    zoneId.length > 0 &&
    port.trim().length > 0 &&
    sshUsername.trim().length > 0 &&
    (!showSshKeyPicker || sshKeyId.length > 0) &&
    !running;

  const handleRun = async () => {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await onRun({
        hostname: hostname.trim(),
        zoneId,
        serviceType,
        port: port.trim(),
        sshUsername: sshUsername.trim(),
        ...(showSshKeyPicker ? { sshKeyId } : {}),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to set up the tunnel"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel={gt("Expose over Cloudflare Tunnel")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl flex flex-col w-[560px] max-h-[80vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-on-surface">
            {gt("Expose over Cloudflare Tunnel")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-secondary text-xl leading-none"
            aria-label={gt("Close")}
          >
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          <T>
            <p className="text-xs text-on-surface-muted">
              Routes a public hostname through tunnel{" "}
              <Var>
                <span className="text-on-surface">{tunnelName}</span>
              </Var>{" "}
              to a service on{" "}
              <Var>
                <span className="text-on-surface">{hostName}</span>
              </Var>
              . The host must currently be SSH-reachable (we connect to install cloudflared) and the
              SSH user needs sudo. Linux only.
            </p>
          </T>

          {result ? (
            <div className="space-y-3">
              {result.steps.map((s) => (
                <div key={s.label} className="flex items-start gap-2 text-sm">
                  <span className={s.ok ? "text-success" : "text-danger"}>{s.ok ? "✓" : "✗"}</span>
                  <div>
                    <div className="text-on-surface-secondary">{s.label}</div>
                    {s.detail && (
                      <div className="text-xs text-on-surface-faint font-mono break-words whitespace-pre-wrap">
                        {s.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {result.connectCommand && (
                <div>
                  <p className="text-xs font-medium text-on-surface-secondary mb-1">
                    {gt("Connect with")}
                  </p>
                  <code className="block text-xs font-mono bg-surface-overlay border border-border rounded p-2 text-accent break-all">
                    {result.connectCommand}
                  </code>
                </div>
              )}
            </div>
          ) : (
            <>
              <div>
                <label
                  htmlFor="tunnel-ssh-hostname"
                  className="block text-xs font-medium text-on-surface-secondary mb-1.5"
                >
                  {gt("Public hostname")}
                  <span className="text-danger ml-0.5">*</span>
                </label>
                <input
                  id="tunnel-ssh-hostname"
                  type="text"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  // i18n-ignore: example hostname
                  placeholder="ssh.example.com"
                  className={inputClass}
                  aria-label={gt("Public hostname")}
                />
              </div>
              <div>
                <label
                  htmlFor="tunnel-ssh-zone"
                  className="block text-xs font-medium text-on-surface-secondary mb-1.5"
                >
                  {gt("Zone")}
                  <span className="text-danger ml-0.5">*</span>
                </label>
                <select
                  id="tunnel-ssh-zone"
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                  className={inputClass}
                  aria-label={gt("Zone")}
                >
                  {zones.length === 0 && <option value="">{gt("No zones found")}</option>}
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label
                    htmlFor="tunnel-ssh-service"
                    className="block text-xs font-medium text-on-surface-secondary mb-1.5"
                  >
                    {gt("Service")}
                    <span className="text-danger ml-0.5">*</span>
                  </label>
                  <select
                    id="tunnel-ssh-service"
                    value={serviceType}
                    onChange={(e) => onServiceChange(e.target.value as TunnelServiceType)}
                    className={inputClass}
                    aria-label={gt("Service")}
                  >
                    {SERVICE_OPTIONS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-28">
                  <label
                    htmlFor="tunnel-ssh-port"
                    className="block text-xs font-medium text-on-surface-secondary mb-1.5"
                  >
                    {gt("Local port")}
                    <span className="text-danger ml-0.5">*</span>
                  </label>
                  <input
                    id="tunnel-ssh-port"
                    type="text"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="8080"
                    className={inputClass}
                    aria-label={gt("Local port")}
                  />
                </div>
              </div>
              <T>
                <p className="-mt-3 text-xs text-on-surface-faint">
                  Exposes{" "}
                  <Var>
                    <span className="font-mono">{`${serviceType}://localhost:${port || "?"}`}</span>
                  </Var>{" "}
                  on the host. HTTP/HTTPS are reachable directly in a browser; SSH/TCP use a{" "}
                  <Var>
                    <span className="font-mono">cloudflared access</span>
                  </Var>{" "}
                  client.
                </p>
              </T>
              <div>
                <label
                  htmlFor={sshUsernameId}
                  className="block text-xs font-medium text-on-surface-secondary mb-1.5"
                >
                  {gt("SSH username")}
                  <span className="text-danger ml-0.5">*</span>
                  <span className="text-on-surface-faint font-normal">
                    {" "}
                    {gt("(to install cloudflared)")}
                  </span>
                </label>
                <input
                  id={sshUsernameId}
                  type="text"
                  value={sshUsername}
                  onChange={(e) => setSshUsername(e.target.value)}
                  placeholder="ubuntu"
                  className={inputClass}
                  aria-label={gt("SSH username")}
                />
              </div>
              {showSshKeyPicker && (
                <div>
                  <label
                    htmlFor="tunnel-ssh-key"
                    className="block text-xs font-medium text-on-surface-secondary mb-1.5"
                  >
                    {gt("SSH key")}
                    <span className="text-danger ml-0.5">*</span>
                  </label>
                  <select
                    id="tunnel-ssh-key"
                    value={sshKeyId}
                    onChange={(e) => setSshKeyId(e.target.value)}
                    className={inputClass}
                    aria-label={gt("SSH key")}
                  >
                    {sshKeys.length === 0 && (
                      <option value="">{gt("No SSH keys in this org")}</option>
                    )}
                    {sshKeys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-on-surface-secondary mb-1">
                  {gt("Runs on the host")}
                </p>
                <pre className="text-[11px] font-mono bg-surface-overlay border border-border rounded p-2 text-on-surface-faint whitespace-pre-wrap">
                  {scriptPreview}
                </pre>
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex-shrink-0">
          {error && (
            <ErrorNotice
              message={error}
              className="mb-3 rounded bg-red-100 dark:bg-red-900/20 px-3 py-2 max-h-40 overflow-y-auto"
              textClassName="text-xs text-danger leading-relaxed break-words"
            />
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
            >
              {result ? gt("Close") : gt("Cancel")}
            </button>
            {!result && (
              <button
                type="button"
                onClick={() => void handleRun()}
                disabled={!canRun}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
              >
                {running ? gt("Setting up…") : gt("Run")}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
