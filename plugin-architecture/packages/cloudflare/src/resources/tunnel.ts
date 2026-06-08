import { f, o, rt } from "@infrawrench/plugin-base";

export const TunnelResourceType = rt({
  name: "Tunnel",
  id: "tunnel",
  description: "A Cloudflare Tunnel for secure origin connections",
  fields: [
    f("name", "Name"),
    f("status", "Status"),
    f("tunnelType", "Tunnel Type", { required: false }),
    f("remoteConfig", "Remote Config", { kind: "boolean", required: false }),
    f("connectionsCount", "Active Connections", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("tunnelId", "Tunnel ID"), o("tunnelToken", "Tunnel Token", { sensitive: true })],
  supportsCreate: true,
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
});
