import { f, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean Uptime check (`/v2/uptime/checks`): an HTTP(S) or ping probe
 * run from up to four regions. Alerts (latency, down, SSL expiry) are
 * children of the check and are managed from its detail page.
 */
export const UptimeCheckResourceType = rt({
  name: "Uptime Check",
  id: "uptime-check",
  description: "A DigitalOcean Uptime check probing a URL or host from several regions.",
  fields: [
    f("name", "Name"),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["https", "http", "ping"],
      description: "https/http fetch the URL; ping sends ICMP to the host.",
    }),
    f("target", "Target", { description: "URL (http/https) or hostname/IP (ping) to probe." }),
    f("regions", "Regions", {
      required: false,
      description: "Comma-separated probe regions: us_east, us_west, eu_west, se_asia.",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
  ],
  outputs: [],
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dashboard",
});
