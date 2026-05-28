import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TunnelResourceType: ResourceTypeDefinition = {
  id: "tunnel",
  displayName: "Tunnel",
  pluralDisplayName: "Tunnels",
  description: "A Cloudflare Tunnel for secure origin connections",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "tunnelType", label: "Tunnel Type", kind: "string", required: false },
    { key: "remoteConfig", label: "Remote Config", kind: "boolean", required: false },
    { key: "connectionsCount", label: "Active Connections", kind: "number", required: false },
    { key: "createdAt", label: "Created", kind: "string", required: false },
  ],
  outputs: [
    { key: "tunnelId", label: "Tunnel ID", sensitive: false },
    { key: "tunnelToken", label: "Tunnel Token", sensitive: true },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  // Drag a tunnel onto any SSH host (EC2, droplet, …) to wire up SSH-over-tunnel.
  sshTunnelAttachSource: true,
  credentialFormats: [
    {
      id: "tunnel-token",
      label: "Tunnel Token",
      description:
        "Run token for cloudflared. Pass to `cloudflared tunnel run --token <token>`. Only works for remotely-managed tunnels.",
      mediaType: "text",
      filenameTemplate: "{resource}.token",
    },
  ],
  secretExportTemplates: [
    {
      id: "tunnel-token",
      displayName: "Tunnel Token",
      description: "Token for running cloudflared tunnel",
      entries: [
        {
          envKey: "TUNNEL_TOKEN",
          outputKey: "tunnelToken",
          description: "Cloudflare Tunnel token",
        },
        { envKey: "TUNNEL_ID", outputKey: "tunnelId", description: "Cloudflare Tunnel ID" },
      ],
    },
  ],
  iconKey: "tunnel",
};
