/**
 * Orchestrates "set up SSH over a Cloudflare Tunnel": point the tunnel's
 * ingress at the host's SSH, create the routing DNS record, then SSH into the
 * host and install/run cloudflared. Spans two accounts (the tunnel's Cloudflare
 * account and the host's provider account), so it lives in the host rather than
 * a single plugin's attachResource.
 */
import type {
  TunnelServiceType,
  TunnelSshAttachResult,
  TunnelSshAttachStep,
} from "@infrawrench/ui";
import { getClientForAccount } from "./plugin-clients";
import { resolveSshConfig, sshExec } from "./ssh";

// Canonical wire shapes live in `@infrawrench/ui` (TunnelSshAttachModal) — the
// modal renders exactly what this service produces. Re-exported so callers of
// this service can keep importing them from here.
export type { TunnelServiceType, TunnelSshAttachResult, TunnelSshAttachStep };

export interface TunnelSshAttachInput {
  organizationId: string;
  tunnel: { accountId: string; pluginId: string; resourceId: string };
  host: { accountId: string; pluginId: string; resourceTypeId: string; resourceId: string };
  hostname: string;
  zoneId: string;
  /** What the tunnel exposes on the host. Defaults to ssh. */
  serviceType?: TunnelServiceType;
  /** Local port the service listens on. Defaults per serviceType. */
  port?: string;
  /** SSH username used to connect for the cloudflared install. */
  sshUsername: string;
  sshKeyId?: string;
}

const DEFAULT_PORT: Record<TunnelServiceType, string> = {
  http: "80",
  https: "443",
  ssh: "22",
  tcp: "0",
};

/**
 * Build the host-side install script. Detects arch, installs cloudflared (deb
 * or raw binary), then registers the systemd service from the remotely-managed
 * tunnel token. The token is interpolated server-side and never returned.
 */
function buildCloudflaredInstallScript(token: string): string {
  return [
    "set -e",
    'ARCH=$(uname -m); case "$ARCH" in x86_64) P=amd64;; aarch64|arm64) P=arm64;; armv7l) P=arm;; *) P=amd64;; esac',
    "BASE=https://github.com/cloudflare/cloudflared/releases/latest/download",
    "if command -v dpkg >/dev/null 2>&1; then",
    '  curl -fsSL -o /tmp/cloudflared.deb "$BASE/cloudflared-linux-$P.deb"',
    "  sudo dpkg -i /tmp/cloudflared.deb",
    "else",
    '  sudo curl -fsSL -o /usr/local/bin/cloudflared "$BASE/cloudflared-linux-$P"',
    "  sudo chmod +x /usr/local/bin/cloudflared",
    "fi",
    `sudo cloudflared service install ${token}`,
    'echo "cloudflared installed"',
  ].join("\n");
}

/** How to reach the service once the tunnel is up — depends on the protocol. */
function tunnelConnectCommand(
  serviceType: TunnelServiceType,
  hostname: string,
  username: string,
  port: string,
): string {
  switch (serviceType) {
    case "http":
    case "https":
      // HTTP(S) is reachable directly in a browser — Cloudflare terminates TLS.
      return `https://${hostname}`;
    case "tcp":
      return `cloudflared access tcp --hostname ${hostname} --url localhost:${port}`;
    case "ssh":
    default:
      return `ssh -o ProxyCommand="cloudflared access ssh --hostname ${hostname}" ${username}@${hostname}`;
  }
}

export async function runTunnelSshAttach(
  input: TunnelSshAttachInput,
): Promise<TunnelSshAttachResult> {
  const steps: TunnelSshAttachStep[] = [];
  const tunnelId = input.tunnel.resourceId.split(":").slice(2).join(":");
  const serviceType: TunnelServiceType = input.serviceType ?? "ssh";
  const port = input.port && input.port.length > 0 ? input.port : DEFAULT_PORT[serviceType];
  const service = `${serviceType}://localhost:${port}`;

  const cf = await getClientForAccount(input.tunnel.accountId, input.organizationId);
  if (!cf) {
    return {
      steps: [{ label: "Load Cloudflare account", ok: false, detail: "Account not found" }],
    };
  }

  // 1. Tunnel ingress → <service> for the hostname.
  try {
    if (!cf.client.updateResource) throw new Error("Cloudflare plugin can't update the tunnel");
    await cf.client.updateResource("tunnel", input.tunnel.resourceId, input.tunnel.accountId, {
      ingressHostname: input.hostname,
      ingressService: service,
    });
    steps.push({
      label: `Set tunnel ingress → ${service} for ${input.hostname}`,
      ok: true,
    });
  } catch (e) {
    steps.push({ label: "Set tunnel ingress", ok: false, detail: errMsg(e) });
    return { steps };
  }

  // 2. Routing DNS CNAME → {tunnelId}.cfargotunnel.com (proxied).
  try {
    if (!cf.client.createResource) throw new Error("Cloudflare plugin can't create DNS records");
    await cf.client.createResource("dns-record", input.tunnel.accountId, {
      zoneId: input.zoneId,
      type: "CNAME",
      name: input.hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: "true",
    });
    steps.push({
      label: `Create DNS CNAME ${input.hostname} → ${tunnelId}.cfargotunnel.com`,
      ok: true,
    });
  } catch (e) {
    // A pre-existing record is fine — surface but don't abort the install.
    steps.push({ label: "Create routing DNS record", ok: false, detail: errMsg(e) });
  }

  // 3. Tunnel run token (server-side only).
  let token: string;
  try {
    if (!cf.client.exportCredential)
      throw new Error("Cloudflare plugin can't export the tunnel token");
    const exported = await cf.client.exportCredential(
      "tunnel",
      input.tunnel.resourceId,
      input.tunnel.accountId,
      "tunnel-token",
    );
    token = exported.content;
    steps.push({ label: "Fetch tunnel run token", ok: true });
  } catch (e) {
    steps.push({ label: "Fetch tunnel run token", ok: false, detail: errMsg(e) });
    return { steps };
  }

  // 4. Resolve the host's SSH address + run the install over SSH.
  try {
    const hostCtx = await getClientForAccount(input.host.accountId, input.organizationId);
    if (!hostCtx) throw new Error("Host account not found");
    const typeDef = hostCtx.plugin.resourceTypes.find((t) => t.id === input.host.resourceTypeId);
    const hostOutputKey = typeDef?.sshEndpoint?.hostOutputKey;
    if (!hostOutputKey) throw new Error("Host type has no sshEndpoint");
    const hostResource = await hostCtx.client.getResource(
      input.host.resourceTypeId,
      input.host.resourceId,
      input.host.accountId,
    );
    const sshHost = String(
      hostResource.resolvedOutputs?.[hostOutputKey] ?? hostResource.fields?.[hostOutputKey] ?? "",
    );
    if (!sshHost) throw new Error("Could not resolve the host's SSH address (is it running?)");

    const sshConfig = await resolveSshConfig(hostCtx.client, input.organizationId, {
      ...(input.sshKeyId ? { sshKeyId: input.sshKeyId } : {}),
      sshHost,
      sshUsername: input.sshUsername,
    });
    const log = await sshExec(
      input.organizationId,
      sshConfig,
      buildCloudflaredInstallScript(token),
    );
    steps.push({ label: "Install & run cloudflared on the host", ok: true, detail: tail(log) });
  } catch (e) {
    steps.push({ label: "Install cloudflared on the host", ok: false, detail: errMsg(e) });
    return { steps };
  }

  return {
    steps,
    connectCommand: tunnelConnectCommand(serviceType, input.hostname, input.sshUsername, port),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Keep only the last few lines of command output for display. */
function tail(text: string, lines = 6): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
