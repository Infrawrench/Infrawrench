import type { CreateResourceConfig } from "@infrawrench/plugin-base";
import { dnsContentField } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./clients/shared.js";

/**
 * Resolve the zone's domain name (e.g. "example.com") from a parent zone
 * resource id, so hostname fields can show a `.<domain>` suffix. Returns
 * undefined when there's no parent (top-level create with a zone picker) or
 * the lookup fails.
 */
async function resolveZoneSuffix(
  api: CloudflareApi,
  parentResourceId?: string,
): Promise<string | undefined> {
  if (!parentResourceId) return undefined;
  const zoneId = parentResourceId.split(":").slice(2).join(":");
  if (!zoneId) return undefined;
  try {
    const zones = await api.getZoneOptions();
    return zones.find((z) => z.id === zoneId)?.label;
  } catch {
    return undefined;
  }
}

export async function getCreateConfig(
  api: CloudflareApi,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  if (typeId === "zone") {
    return {
      fields: [
        {
          key: "name",
          label: "Domain Name",
          kind: "text",
          required: true,
          description: "The domain name to add to Cloudflare (e.g. example.com)",
        },
      ],
    };
  }
  if (typeId === "dns-record") {
    const fields: CreateResourceConfig["fields"] = [];
    const zoneSuffix = await resolveZoneSuffix(api, parentResourceId);
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "type",
        label: "Record Type",
        kind: "select",
        required: true,
        options: [
          { id: "A", label: "A" },
          { id: "AAAA", label: "AAAA" },
          { id: "CNAME", label: "CNAME" },
          { id: "MX", label: "MX" },
          { id: "TXT", label: "TXT" },
          { id: "NS", label: "NS" },
          { id: "SRV", label: "SRV" },
          { id: "CAA", label: "CAA" },
        ],
      },
      {
        key: "name",
        label: "Name",
        required: true,
        ...(zoneSuffix
          ? {
              kind: "hostname" as const,
              hostnameSuffix: zoneSuffix,
              description: "Subdomain — leave blank for the root domain.",
            }
          : {
              kind: "text" as const,
              description: 'Record name (e.g. "@" for root, "www" for subdomain)',
            }),
      },
      ...dnsContentField({
        key: "content",
        label: "Content",
        placeholder: "IP address, hostname, or text value",
      }),
      {
        key: "ttl",
        label: "TTL",
        kind: "select",
        required: false,
        defaultValue: "1",
        options: [
          { id: "1", label: "Auto" },
          { id: "60", label: "1 minute" },
          { id: "300", label: "5 minutes" },
          { id: "600", label: "10 minutes" },
          { id: "3600", label: "1 hour" },
          { id: "86400", label: "1 day" },
        ],
      },
      {
        key: "proxied",
        label: "Proxied",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "true", label: "Proxied (orange cloud)" },
          { id: "false", label: "DNS Only (gray cloud)" },
        ],
      },
      {
        key: "priority",
        label: "Priority",
        kind: "number",
        required: false,
        description: "Required for MX and SRV records",
        showWhen: { fieldKey: "type", fieldValue: "MX" },
        minValue: 0,
        maxValue: 65535,
      },
    );
    return { fields };
  }
  if (typeId === "r2-bucket") {
    return {
      fields: [
        {
          key: "name",
          label: "Bucket Name",
          kind: "text",
          required: true,
          description: "Globally unique bucket name (lowercase, hyphens, 3-63 chars)",
        },
        {
          key: "locationHint",
          label: "Location Hint",
          kind: "select",
          required: false,
          options: [
            { id: "", label: "Automatic" },
            { id: "wnam", label: "Western North America" },
            { id: "enam", label: "Eastern North America" },
            { id: "weur", label: "Western Europe" },
            { id: "eeur", label: "Eastern Europe" },
            { id: "apac", label: "Asia-Pacific" },
          ],
        },
      ],
    };
  }
  if (typeId === "kv-namespace") {
    return {
      fields: [{ key: "title", label: "Namespace Title", kind: "text", required: true }],
    };
  }
  if (typeId === "d1-database") {
    return {
      fields: [{ key: "name", label: "Database Name", kind: "text", required: true }],
    };
  }
  if (typeId === "queue") {
    return {
      fields: [{ key: "queue_name", label: "Queue Name", kind: "text", required: true }],
    };
  }
  if (typeId === "hyperdrive") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "host",
          label: "Origin Host",
          kind: "text",
          required: true,
          description: "Hostname of the database server",
        },
        {
          key: "port",
          label: "Origin Port",
          kind: "number",
          required: true,
          defaultValue: "5432",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "scheme",
          label: "Protocol",
          kind: "select",
          required: true,
          defaultValue: "postgres",
          options: [
            { id: "postgres", label: "PostgreSQL" },
            { id: "mysql", label: "MySQL" },
          ],
        },
        { key: "database", label: "Database Name", kind: "text", required: true },
        { key: "user", label: "Username", kind: "text", required: true },
        { key: "password", label: "Password", kind: "password", required: true },
      ],
    };
  }
  if (typeId === "tunnel") {
    return {
      fields: [
        {
          key: "name",
          label: "Tunnel Name",
          kind: "text",
          required: true,
          description: "A descriptive name for the tunnel",
        },
      ],
    };
  }
  if (typeId === "worker-route") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    const zoneSuffix = await resolveZoneSuffix(api, parentResourceId);
    fields.push(
      {
        key: "pattern",
        label: "Route Pattern",
        required: true,
        description: "URL pattern (e.g. example.com/path/*)",
        ...(zoneSuffix
          ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix, hostnamePath: true }
          : { kind: "text" as const }),
      },
      {
        key: "scriptName",
        label: "Worker Script",
        kind: "resource-picker",
        required: true,
        description: "Worker script to route to",
        associationSources: [
          { pluginId: "cloudflare", resourceTypeId: "worker", outputKey: "workerName" },
        ],
      },
    );
    return { fields };
  }
  if (typeId === "page-rule") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "urlPattern",
        label: "URL Pattern",
        kind: "text",
        required: true,
        description: "URL pattern to match (e.g. *example.com/images/*)",
      },
      {
        key: "action",
        label: "Action",
        kind: "select",
        required: true,
        options: [
          { id: "forwarding_url", label: "Forwarding URL" },
          { id: "always_use_https", label: "Always Use HTTPS" },
          { id: "cache_level", label: "Cache Level" },
          { id: "ssl", label: "SSL" },
          { id: "browser_cache_ttl", label: "Browser Cache TTL" },
          { id: "security_level", label: "Security Level" },
        ],
      },
      {
        key: "actionValue",
        label: "Action Value",
        kind: "text",
        required: false,
        description: "Value for the action (e.g. URL for forwarding, cache level)",
      },
    );
    return { fields };
  }
  if (typeId === "firewall-rule") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "description",
        label: "Description",
        kind: "text",
        required: false,
        description: "A human-readable description for this rule",
      },
      {
        key: "expression",
        label: "Expression",
        kind: "text",
        required: true,
        description: "Firewall expression (e.g. ip.src eq 1.2.3.4)",
      },
      {
        key: "action",
        label: "Action",
        kind: "select",
        required: true,
        options: [
          { id: "block", label: "Block" },
          { id: "challenge", label: "Challenge" },
          { id: "js_challenge", label: "JS Challenge" },
          { id: "managed_challenge", label: "Managed Challenge" },
          { id: "allow", label: "Allow" },
          { id: "log", label: "Log" },
          { id: "skip", label: "Skip" },
        ],
      },
    );
    return { fields };
  }
  if (typeId === "custom-hostname") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "hostname",
        label: "Hostname",
        kind: "text",
        required: true,
        description: "The custom hostname to add (e.g. app.customer.com)",
      },
      {
        key: "sslMethod",
        label: "SSL Validation Method",
        kind: "select",
        required: true,
        defaultValue: "http",
        options: [
          { id: "http", label: "HTTP" },
          { id: "txt", label: "TXT (DNS)" },
          { id: "email", label: "Email" },
        ],
      },
    );
    return { fields };
  }
  if (typeId === "email-routing-rule") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "name",
        label: "Rule Name",
        kind: "text",
        required: false,
        description: "A descriptive name for the rule",
      },
      {
        key: "matcherField",
        label: "Match Field",
        kind: "select",
        required: true,
        options: [
          { id: "to", label: "Recipient (To)" },
          { id: "from", label: "Sender (From)" },
        ],
      },
      {
        key: "matcherValue",
        label: "Match Value",
        kind: "text",
        required: true,
        description: "Email address to match",
      },
      {
        key: "actionType",
        label: "Action",
        kind: "select",
        required: true,
        options: [
          { id: "forward", label: "Forward to" },
          { id: "worker", label: "Send to Worker" },
          { id: "drop", label: "Drop" },
        ],
      },
      {
        key: "actionValue",
        label: "Action Value",
        kind: "text",
        required: false,
        description: "Destination email address (for forward) or Worker name",
      },
    );
    return { fields };
  }
  if (typeId === "waiting-room") {
    const fields: CreateResourceConfig["fields"] = [];
    const zoneSuffix = await resolveZoneSuffix(api, parentResourceId);
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "name",
        label: "Name",
        kind: "text",
        required: true,
        description: "Unique name for the waiting room",
      },
      {
        key: "host",
        label: "Host",
        required: true,
        description: "Hostname to apply the waiting room to",
        ...(zoneSuffix
          ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix }
          : { kind: "text" as const }),
      },
      {
        key: "totalActiveUsers",
        label: "Total Active Users",
        kind: "number",
        required: true,
        description: "Maximum number of active users allowed",
        minValue: 200,
        maxValue: 2147483647,
      },
      {
        key: "newUsersPerMinute",
        label: "New Users Per Minute",
        kind: "number",
        required: true,
        description: "Rate of new users admitted per minute",
        minValue: 200,
        maxValue: 2147483647,
      },
    );
    return { fields };
  }
  if (typeId === "ssl-certificate") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "certificate",
        label: "Certificate (PEM)",
        kind: "text",
        required: true,
        description: "The PEM-encoded SSL certificate",
      },
      {
        key: "privateKey",
        label: "Private Key (PEM)",
        kind: "text",
        required: true,
        description: "The PEM-encoded private key",
      },
    );
    return { fields };
  }
  if (typeId === "logpush-job") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "destinationConf",
        label: "Destination",
        kind: "text",
        required: true,
        description: "Destination URL (e.g. s3://bucket/path?region=us-east-1)",
      },
      {
        key: "dataset",
        label: "Dataset",
        kind: "select",
        required: true,
        options: [
          { id: "http_requests", label: "HTTP Requests" },
          { id: "firewall_events", label: "Firewall Events" },
          { id: "spectrum_events", label: "Spectrum Events" },
          { id: "nel_reports", label: "NEL Reports" },
          { id: "dns_logs", label: "DNS Logs" },
        ],
      },
      {
        key: "name",
        label: "Job Name",
        kind: "text",
        required: false,
        description: "Optional name for the logpush job",
      },
    );
    return { fields };
  }
  if (typeId === "access-application") {
    return {
      fields: [
        {
          key: "name",
          label: "Application Name",
          kind: "text",
          required: true,
          description: "Name for the Access application",
        },
        {
          key: "domain",
          label: "Application Domain",
          kind: "text",
          required: true,
          description: "Domain the application is available on (e.g. app.example.com)",
        },
        {
          key: "type",
          label: "Application Type",
          kind: "select",
          required: true,
          defaultValue: "self_hosted",
          options: [
            { id: "self_hosted", label: "Self-Hosted" },
            { id: "saas", label: "SaaS" },
            { id: "ssh", label: "SSH" },
            { id: "vnc", label: "VNC" },
            { id: "bookmark", label: "Bookmark" },
          ],
        },
      ],
    };
  }
  if (typeId === "access-policy") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "appId",
        label: "Access Application",
        kind: "select",
        required: true,
        options: await api.getAccessAppOptions(),
      });
    }
    fields.push(
      {
        key: "name",
        label: "Policy Name",
        kind: "text",
        required: true,
        description: "Name for the policy",
      },
      {
        key: "decision",
        label: "Decision",
        kind: "select",
        required: true,
        options: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny" },
          { id: "non_identity", label: "Non-Identity" },
          { id: "bypass", label: "Bypass" },
        ],
      },
      {
        key: "includeEmail",
        label: "Include Emails",
        kind: "string-list",
        required: true,
        placeholder: "user@example.com or @example.com",
        addLabel: "+ Add email or domain",
        description:
          "A bare address (user@example.com) matches that user; a leading @ (@example.com) matches everyone at that domain.",
      },
    );
    return { fields };
  }
  if (typeId === "load-balancer") {
    const fields: CreateResourceConfig["fields"] = [];
    const zoneSuffix = await resolveZoneSuffix(api, parentResourceId);
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "name",
        label: "Name",
        required: true,
        description: "DNS name for the load balancer",
        ...(zoneSuffix
          ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix }
          : { kind: "text" as const }),
      },
      {
        key: "fallbackPool",
        label: "Fallback Pool ID",
        kind: "text",
        required: true,
        description: "Pool ID to use when all other pools are unhealthy",
      },
      {
        key: "defaultPools",
        label: "Default Pool IDs",
        kind: "string-list",
        required: true,
        placeholder: "pool ID",
        addLabel: "+ Add pool",
        description: "Pool IDs to use for default traffic",
      },
    );
    return { fields };
  }
  if (typeId === "spectrum-application") {
    const fields: CreateResourceConfig["fields"] = [];
    const zoneSuffix = await resolveZoneSuffix(api, parentResourceId);
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "protocol",
        label: "Protocol",
        kind: "select",
        required: true,
        options: [
          { id: "tcp/22", label: "TCP/22 (SSH)" },
          { id: "tcp/80", label: "TCP/80 (HTTP)" },
          { id: "tcp/443", label: "TCP/443 (HTTPS)" },
          { id: "tcp/3389", label: "TCP/3389 (RDP)" },
          { id: "tcp/8080", label: "TCP/8080" },
          { id: "udp/53", label: "UDP/53 (DNS)" },
        ],
      },
      {
        key: "dns",
        label: "DNS Name",
        required: true,
        description: "Subdomain for the Spectrum app",
        ...(zoneSuffix
          ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix }
          : { kind: "text" as const }),
      },
      {
        key: "originDirect",
        label: "Origin Direct",
        kind: "string-list",
        required: true,
        placeholder: "203.0.113.1:22",
        addLabel: "+ Add origin",
        description: "Origin addresses in IP:port format (e.g. 203.0.113.1:22)",
      },
      {
        key: "ipFirewall",
        label: "IP Firewall",
        kind: "select",
        required: false,
        options: [
          { id: "true", label: "Enabled" },
          { id: "false", label: "Disabled" },
        ],
        defaultValue: "false",
      },
    );
    return { fields };
  }
  if (typeId === "ip-access-rule") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "mode",
        label: "Action",
        kind: "select",
        required: true,
        defaultValue: "block",
        options: [
          { id: "block", label: "Block" },
          { id: "challenge", label: "Interactive Challenge" },
          { id: "js_challenge", label: "JS Challenge" },
          { id: "managed_challenge", label: "Managed Challenge" },
          { id: "whitelist", label: "Allow (whitelist)" },
        ],
      },
      {
        key: "target",
        label: "Match Type",
        kind: "select",
        required: true,
        defaultValue: "ip",
        options: [
          { id: "ip", label: "IP address" },
          { id: "ip_range", label: "IP range (CIDR)" },
          { id: "asn", label: "ASN" },
          { id: "country", label: "Country" },
        ],
      },
      {
        key: "value",
        label: "Value",
        kind: "text",
        required: true,
        description: "e.g. 203.0.113.1, 203.0.113.0/24, AS13335, or a 2-letter country code",
      },
      {
        key: "notes",
        label: "Notes",
        kind: "text",
        required: false,
        description: "Optional description for this rule",
      },
    );
    return { fields };
  }
  if (typeId === "rate-limit-rule" || typeId === "redirect-rule" || typeId === "cache-rule") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push({
      key: "description",
      label: "Description",
      kind: "text",
      required: false,
      description: "A human-readable name for this rule",
    });
    fields.push({
      key: "expression",
      label: "Expression",
      kind: "text",
      required: true,
      description: 'Rules-language match expression (e.g. http.request.uri.path eq "/old")',
    });
    if (typeId === "rate-limit-rule") {
      fields.push(
        {
          key: "requestsPerPeriod",
          label: "Requests",
          kind: "number",
          required: true,
          defaultValue: "100",
          minValue: 1,
          description: "Max requests allowed per period before the action fires",
        },
        {
          key: "period",
          label: "Period",
          kind: "select",
          required: true,
          defaultValue: "60",
          options: [
            { id: "10", label: "10 seconds" },
            { id: "60", label: "1 minute" },
            { id: "120", label: "2 minutes" },
            { id: "300", label: "5 minutes" },
            { id: "600", label: "10 minutes" },
            { id: "3600", label: "1 hour" },
          ],
        },
        {
          key: "characteristics",
          label: "Counting characteristics",
          kind: "string-list",
          required: false,
          defaultValue: "ip.src",
          placeholder: "ip.src",
          addLabel: "+ Add characteristic",
          description: "Counting keys (e.g. ip.src, http.request.headers)",
        },
        {
          key: "action",
          label: "Action",
          kind: "select",
          required: true,
          defaultValue: "block",
          options: [
            { id: "block", label: "Block" },
            { id: "managed_challenge", label: "Managed Challenge" },
            { id: "js_challenge", label: "JS Challenge" },
            { id: "challenge", label: "Interactive Challenge" },
            { id: "log", label: "Log" },
          ],
        },
      );
    } else if (typeId === "redirect-rule") {
      fields.push(
        {
          key: "target",
          label: "Target URL",
          kind: "text",
          required: true,
          description: "Destination URL to redirect to (e.g. https://example.com/new)",
        },
        {
          key: "statusCode",
          label: "Status Code",
          kind: "select",
          required: true,
          defaultValue: "301",
          options: [
            { id: "301", label: "301 Moved Permanently" },
            { id: "302", label: "302 Found" },
            { id: "307", label: "307 Temporary Redirect" },
            { id: "308", label: "308 Permanent Redirect" },
          ],
        },
        {
          key: "preserveQuery",
          label: "Preserve Query String",
          kind: "select",
          required: false,
          defaultValue: "true",
          options: [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ],
        },
      );
    } else {
      // cache-rule
      fields.push(
        {
          key: "cache",
          label: "Cache Eligibility",
          kind: "select",
          required: true,
          defaultValue: "true",
          options: [
            { id: "true", label: "Eligible for cache" },
            { id: "false", label: "Bypass cache" },
          ],
        },
        {
          key: "edgeTtl",
          label: "Edge TTL (seconds)",
          kind: "number",
          required: false,
          minValue: 0,
          description: "Override edge cache TTL (leave blank to respect origin headers)",
          showWhen: { fieldKey: "cache", fieldValue: "true" },
        },
      );
    }
    return { fields };
  }
  if (typeId === "worker") {
    return {
      fields: [
        {
          key: "name",
          label: "Worker Name",
          kind: "text",
          required: true,
          description: "Script name for the worker",
        },
        {
          key: "script",
          label: "Script Content",
          kind: "text",
          required: true,
          defaultValue:
            'export default {\n  async fetch(request) {\n    return new Response("Hello World!");\n  }\n};',
          description: "Worker script (ES module format)",
        },
        {
          key: "compatibilityDate",
          label: "Compatibility Date",
          kind: "datetime",
          datetimeMode: "date",
          required: false,
          defaultValue: new Date().toISOString().split("T")[0] ?? "",
        },
      ],
    };
  }
  if (typeId === "turnstile-widget") {
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "A human-readable label for this widget",
        },
        {
          key: "domains",
          label: "Domains",
          kind: "string-list",
          required: false,
          placeholder: "example.com",
          addLabel: "+ Add domain",
          description: "Hostnames allowed to use this widget",
        },
        {
          key: "mode",
          label: "Widget Mode",
          kind: "select",
          required: false,
          defaultValue: "managed",
          options: [
            { id: "managed", label: "Managed (recommended)" },
            { id: "non-interactive", label: "Non-interactive" },
            { id: "invisible", label: "Invisible" },
          ],
        },
      ],
    };
  }
  if (typeId === "healthcheck") {
    const fields: CreateResourceConfig["fields"] = [];
    if (!parentResourceId) {
      fields.push({
        key: "zoneId",
        label: "Zone",
        kind: "select",
        required: true,
        options: await api.getZoneOptions(),
      });
    }
    fields.push(
      {
        key: "name",
        label: "Name",
        kind: "text",
        required: true,
        description: "A name for this health check",
      },
      {
        key: "address",
        label: "Address",
        kind: "text",
        required: true,
        description: "Hostname or IP address to monitor (e.g. origin.example.com)",
      },
      {
        key: "type",
        label: "Protocol",
        kind: "select",
        required: false,
        defaultValue: "HTTPS",
        options: [
          { id: "HTTPS", label: "HTTPS" },
          { id: "HTTP", label: "HTTP" },
          { id: "TCP", label: "TCP" },
        ],
      },
      {
        key: "path",
        label: "Path",
        kind: "text",
        required: false,
        defaultValue: "/",
        description: "Request path (HTTP/HTTPS only)",
        showWhen: { fieldKey: "type", fieldValue: "HTTPS" },
      },
      {
        key: "description",
        label: "Description",
        kind: "text",
        required: false,
      },
    );
    return { fields };
  }
  if (typeId === "notification-policy") {
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "A name for this notification policy",
        },
        {
          key: "alertType",
          label: "Alert Type",
          kind: "select",
          required: true,
          defaultValue: "universal_ssl_event_type",
          options: [
            { id: "universal_ssl_event_type", label: "Universal SSL event" },
            { id: "dedicated_ssl_certificate_event_type", label: "Advanced certificate event" },
            { id: "health_check_status_notification", label: "Health check status change" },
            { id: "load_balancing_health_alert", label: "Load balancing health alert" },
            { id: "http_alert_origin_error", label: "Origin error rate alert" },
            { id: "http_alert_edge_error", label: "Edge error rate alert" },
            { id: "dos_attack_l7", label: "HTTP DDoS attack" },
            { id: "billing_usage_alert", label: "Billing usage alert" },
            { id: "expiring_service_token_alert", label: "Expiring service token" },
            {
              id: "failing_logpush_job_disabled_alert",
              label: "Failing Logpush job disabled",
            },
          ],
        },
        {
          key: "email",
          label: "Notify Emails",
          kind: "string-list",
          required: true,
          placeholder: "ops@example.com",
          addLabel: "+ Add email",
          description: "Email addresses to notify",
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
      ],
    };
  }
  if (typeId === "vectorize-index") {
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "Index name (lowercase letters, numbers, hyphens)",
        },
        {
          key: "dimensions",
          label: "Dimensions",
          kind: "number",
          required: true,
          defaultValue: "768",
          description: "Vector dimensionality (must match your embedding model)",
          minValue: 1,
          maxValue: 1536,
        },
        {
          key: "metric",
          label: "Distance Metric",
          kind: "select",
          required: false,
          defaultValue: "cosine",
          options: [
            { id: "cosine", label: "Cosine" },
            { id: "euclidean", label: "Euclidean" },
            { id: "dot-product", label: "Dot product" },
          ],
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
      ],
    };
  }
  if (typeId === "ai-gateway") {
    return {
      fields: [
        {
          key: "id",
          label: "Gateway ID",
          kind: "text",
          required: true,
          description:
            "Gateway slug (lowercase letters, numbers, hyphens) — used in the gateway URL",
        },
        {
          key: "collectLogs",
          label: "Collect Logs",
          kind: "select",
          required: false,
          defaultValue: "true",
          description: "Store request/response logs for analytics and debugging",
          options: [
            { id: "true", label: "Enabled" },
            { id: "false", label: "Disabled" },
          ],
        },
        {
          key: "cacheTtl",
          label: "Cache TTL (seconds)",
          kind: "number",
          required: false,
          description: "How long to cache identical requests. Leave blank to disable caching.",
          minValue: 0,
        },
        {
          key: "cacheInvalidateOnUpdate",
          label: "Invalidate Cache on Update",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "true", label: "Enabled" },
            { id: "false", label: "Disabled" },
          ],
        },
        {
          key: "rateLimitingLimit",
          label: "Rate Limit (requests)",
          kind: "number",
          required: false,
          description: "Max requests per window. Leave blank for no rate limit.",
          minValue: 0,
        },
        {
          key: "rateLimitingInterval",
          label: "Rate Limit Window (seconds)",
          kind: "number",
          required: false,
          minValue: 0,
        },
        {
          key: "rateLimitingTechnique",
          label: "Rate Limit Technique",
          kind: "select",
          required: false,
          defaultValue: "fixed",
          showWhen: { fieldKey: "rateLimitingLimit", fieldValuesNot: [""] },
          options: [
            { id: "fixed", label: "Fixed window" },
            { id: "sliding", label: "Sliding window" },
          ],
        },
        {
          key: "authentication",
          label: "Authenticated Gateway",
          kind: "select",
          required: false,
          defaultValue: "false",
          description: "Require a Cloudflare token on every request to the gateway",
          options: [
            { id: "true", label: "Enabled" },
            { id: "false", label: "Disabled" },
          ],
        },
        {
          key: "logpush",
          label: "Logpush",
          kind: "select",
          required: false,
          defaultValue: "false",
          description: "Forward gateway logs to a Logpush destination",
          options: [
            { id: "true", label: "Enabled" },
            { id: "false", label: "Disabled" },
          ],
        },
      ],
    };
  }
  throw new Error(`Cloudflare plugin: getCreateConfig not supported for type "${typeId}"`);
}
