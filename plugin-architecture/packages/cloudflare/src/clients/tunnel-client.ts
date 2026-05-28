import type { CredentialExport, ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

function mapTunnel(t: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(t["id"] ?? "");
  const name = String(t["name"] ?? "");
  const connections = Array.isArray(t["connections"]) ? (t["connections"] as Array<unknown>) : [];
  const status = String(t["status"] ?? (connections.length > 0 ? "active" : "inactive"));
  return {
    id: `${accountId}:tunnel:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "tunnel",
    accountId,
    displayName: name || id,
    fields: {
      name,
      status,
      tunnelType: String(t["tun_type"] ?? ""),
      remoteConfig: Boolean(t["remote_config"]),
      connectionsCount: connections.length,
      createdAt: String(t["created_at"] ?? ""),
    },
    resolvedOutputs: { tunnelId: id },
    secretStates: [],
    externalId: id,
    createdAt: String(t["created_at"] ?? new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

export async function listTunnels(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const t of api.cf.zeroTrust.tunnels.cloudflared.list({ account_id })) {
    const raw = t as unknown as Record<string, unknown>;
    if (raw["deleted_at"]) continue; // exclude soft-deleted tunnels
    results.push(mapTunnel(raw, accountId));
  }
  return results;
}

export async function createTunnel(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const tunnel = await api.cf.zeroTrust.tunnels.cloudflared.create({
    account_id,
    name: fields["name"] ?? "",
    tunnel_secret: btoa(crypto.randomUUID()),
  });
  return mapTunnel(tunnel as unknown as Record<string, unknown>, accountId);
}

export async function deleteTunnel(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.zeroTrust.tunnels.cloudflared.delete(externalId, { account_id });
}

export async function getTunnelToken(
  api: CloudflareApi,
  tunnelExternalId: string,
): Promise<string> {
  const account_id = await api.getAccountId();
  return await api.cf.zeroTrust.tunnels.cloudflared.token.get(tunnelExternalId, { account_id });
}

/**
 * Set (replace) the tunnel's remotely-managed ingress so `hostname` routes to
 * a local `service` on the machine running cloudflared — e.g.
 * `ssh://localhost:22`, `http://localhost:8080`, `https://localhost:443`,
 * `tcp://localhost:5432`. A catch-all `http_status:404` rule is required by
 * Cloudflare as the last entry.
 *
 * Uses the raw PUT helper because the SDK's per-config typing is a moving
 * target; the `/configurations` endpoint accepts `{ config: { ingress } }`.
 */
export async function setTunnelIngress(
  api: CloudflareApi,
  tunnelExternalId: string,
  hostname: string,
  service: string,
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.put<unknown, unknown>(
    `/accounts/${account_id}/cfd_tunnel/${tunnelExternalId}/configurations`,
    {
      body: {
        config: {
          ingress: [{ hostname, service }, { service: "http_status:404" }],
        },
      },
    },
  );
}

export async function exportTunnelCredential(
  api: CloudflareApi,
  resource: ResourceInstance,
): Promise<CredentialExport> {
  const token = await getTunnelToken(api, String(resource.externalId ?? ""));
  const name = String(resource.fields["name"] ?? resource.externalId ?? "tunnel");
  return {
    content: token,
    filename: `${name}.token`,
    mimeType: "text/plain",
    fields: [
      { label: "Tunnel ID", value: String(resource.externalId ?? "") },
      { label: "Run Token", value: token, sensitive: true, hint: "Paste into cloudflared" },
    ],
    warning:
      "Run with: cloudflared tunnel run --token <token>. Anyone with this token can impersonate the tunnel. Rotate via the Cloudflare dashboard if exposed.",
  };
}
