import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import {
  formatBytes,
  joinSubtitle,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

export const DEFAULT_METRICS_WINDOW_MS = 7 * 86_400_000;
const DASH = "https://dash.bunny.net";

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function bytes(v: unknown): string {
  return typeof v === "number" ? formatBytes(v) : "";
}

function usd(v: unknown): string {
  return typeof v === "number" ? `$${v.toFixed(2)}` : "";
}

function kv(rows: Array<[string, unknown, boolean?]>): SchemaNode {
  const items: KVItem[] = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, v, copy]) => ({
      key,
      value: typeof v === "boolean" ? (v ? "Yes" : "No") : String(v),
      ...(copy ? { copyable: true } : {}),
    }));
  return { kind: "key-value-list", items };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", content, variant: "muted" };
}

function link(label: string, url: string): ActionNode {
  return { kind: "action", label, variant: "ghost", action: { type: "open-url", url } };
}

function act(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.danger ? { variant: "danger" as const } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let rows: TableRow[] = [];
  try {
    rows = Object.entries(JSON.parse(str(f["chargesBreakdown"]) || "{}") as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .map(([product, amount]) => ({ cells: { product, amount: usd(amount) } }));
  } catch {
    rows = [];
  }
  return {
    title: r.displayName,
    subtitle: "bunny.net account",
    sections: [
      section("Billing", [
        kv([
          ["Prepaid balance", usd(f["balance"])],
          ["Charges this month", usd(f["thisMonthCharges"])],
          ["Coupon balance", usd(f["couponBalance"])],
          ["Pull zones", f["pullZoneCount"]],
          ["Storage zones", f["storageZoneCount"]],
          ["DNS zones", f["dnsZoneCount"]],
        ]),
      ]),
      section("This month by product", [
        rows.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "product", label: "Product", width: "wide" },
                { key: "amount", label: "Charges" },
              ],
              rows,
            }
          : muted("No charges yet this month."),
      ]),
    ],
    headerActions: [
      { ...link("Billing", `${DASH}/account/billing`) },
      {
        kind: "action",
        label: "Purge a URL",
        action: {
          type: "prompt-nosql-command",
          command: "purge-url",
          title: "Purge a URL",
          description:
            "Removes one URL from the cache of whichever pull zone serves it. Use * at the end to purge everything under a path.",
          fields: [
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: true,
              placeholder: "https://cdn.example.com/images/logo.png",
            },
          ],
          submitLabel: "Purge",
        },
      },
    ],
  };
}

function renderPullZone(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const host = str(f["cdnHostname"]);
  const status = f["suspended"] === true ? "error" : f["enabled"] === false ? "info" : "healthy";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Pull zone", str(f["type"]), host),
    status: {
      kind: "status-dot",
      status,
      label: f["suspended"] === true ? "Suspended" : f["enabled"] === false ? "Disabled" : "Active",
    },
    sections: [
      section("Pull zone", [
        kv([
          ["CDN hostname", host, true],
          [
            "Origin",
            str(f["originType"]) === "Standard" || !f["originType"]
              ? f["originUrl"]
              : `${str(f["originType"])}${f["originUrl"] ? `: ${str(f["originUrl"])}` : ""}`,
          ],
          ["Tier", f["type"]],
          ["Hostnames", f["hostnames"]],
          ["Bandwidth this month", bytes(f["monthlyBandwidthUsed"])],
          ["Charges this month", usd(f["monthlyCharges"])],
          [
            "Monthly bandwidth limit",
            f["monthlyBandwidthLimit"] ? bytes(f["monthlyBandwidthLimit"]) : "Unlimited",
          ],
        ]),
      ]),
      section("Caching and security", [
        kv([
          [
            "Cache expiration",
            f["cacheMaxAgeOverride"] === -1
              ? "Respect origin"
              : f["cacheMaxAgeOverride"] !== undefined
                ? `${str(f["cacheMaxAgeOverride"])} s`
                : "",
          ],
          [
            "Browser cache",
            f["browserMaxAgeOverride"] === -1
              ? "Match server"
              : f["browserMaxAgeOverride"] !== undefined
                ? `${str(f["browserMaxAgeOverride"])} s`
                : "",
          ],
          ["Ignore query strings", f["ignoreQueryStrings"]],
          ["Smart cache", f["smartCache"]],
          ["Origin Shield", f["originShield"]],
          ["Optimizer", f["optimizer"]],
          ["Logging", f["logging"]],
          ["Verify origin SSL", f["verifyOriginSsl"]],
          ["Token authentication", f["tokenAuthentication"]],
          ["Blocked countries", f["blockedCountries"]],
          ["Allowed referrers", f["allowedReferrers"]],
          ["Blocked IPs", f["blockedIps"]],
          [
            "Serves",
            [
              ["geoUS", "North America"],
              ["geoEU", "Europe"],
              ["geoASIA", "Asia"],
              ["geoSA", "South America"],
              ["geoAF", "Africa"],
            ]
              .filter(([k]) => f[k!] !== false)
              .map(([, l]) => l)
              .join(", "),
          ],
        ]),
      ]),
    ],
    customTabs: [
      { id: "edge", label: "Hostnames and rules", childResourceTypeIds: ["hostname", "edge-rule"] },
    ],
    childTables: [
      {
        title: "Hostnames",
        typeId: "hostname",
        onRowClick: "edit",
        readOnlyRowWhen: { fieldKey: "isSystem", fieldValues: ["true"] },
        columns: [
          { key: "host", label: "Hostname", source: { kind: "display-name" }, format: "mono" },
          {
            key: "ssl",
            label: "Certificate",
            source: { kind: "field", fieldKey: "hasCertificate" },
            format: "boolean-yesno",
          },
          {
            key: "force",
            label: "Force SSL",
            source: { kind: "field", fieldKey: "forceSsl" },
            format: "boolean-yesno",
          },
        ],
      },
      {
        title: "Edge rules",
        typeId: "edge-rule",
        onRowClick: "edit",
        columns: [
          { key: "desc", label: "Rule", source: { kind: "display-name" } },
          { key: "action", label: "Action", source: { kind: "field", fieldKey: "action" } },
          { key: "trigger", label: "Trigger", source: { kind: "field", fieldKey: "triggerType" } },
          {
            key: "on",
            label: "Enabled",
            source: { kind: "field", fieldKey: "enabled" },
            format: "boolean-yesno",
          },
        ],
      },
    ],
    headerActions: [
      {
        kind: "action",
        label: "Purge URL",
        action: {
          type: "prompt-nosql-command",
          command: "purge-url",
          title: "Purge a URL",
          description:
            "Removes one URL from the cache. End the path with * to purge everything under it.",
          fields: [
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: true,
              placeholder: host ? `https://${host}/path/file.jpg` : "https://cdn.example.com/path",
            },
          ],
          submitLabel: "Purge",
        },
      },
      {
        kind: "action",
        label: "Purge by tag",
        action: {
          type: "prompt-nosql-command",
          command: "purge-tag",
          title: "Purge by cache tag",
          description:
            "Removes every object your origin tagged with this value in the CDN-Tag header.",
          fields: [{ key: "tag", label: "Cache tag", kind: "text", required: true }],
          submitLabel: "Purge",
        },
      },
      act("Purge everything", "purge-all", {
        danger: true,
        destructive: true,
        confirm:
          "Purge this pull zone's whole cache? Every request goes back to the origin until the cache warms up again.",
        success: "Cache purged",
      }),
      {
        kind: "action",
        label: "Add hostname",
        action: {
          type: "prompt-nosql-command",
          command: "add-hostname",
          title: "Add a custom hostname",
          description: `Point a CNAME for the hostname at ${host || "the pull zone's b-cdn.net hostname"} first, then add it here. Infrawrench requests a free certificate for it once it is added.`,
          fields: [
            {
              key: "hostname",
              label: "Hostname",
              kind: "text",
              required: true,
              placeholder: "cdn.example.com",
            },
            {
              key: "certificate",
              label: "Free SSL certificate",
              kind: "select",
              required: true,
              defaultValue: "yes",
              options: [
                { id: "yes", label: "Request one now" },
                { id: "no", label: "Not now" },
              ],
            },
          ],
          submitLabel: "Add",
        },
      },
      act("Reset token key", "reset-token-key", {
        confirm:
          "Generate a new token authentication key? Signed URLs made with the old key stop working.",
        success: "Token key reset",
      }),
      link("Open in dashboard", `${DASH}/cdn/${r.externalId ?? ""}/general`),
    ],
  };
}

function renderHostname(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Pull zone hostname",
    status: {
      kind: "status-dot",
      status: f["hasCertificate"] === true ? "healthy" : "degraded",
      label: f["hasCertificate"] === true ? "HTTPS" : "No certificate",
    },
    sections: [
      section("Hostname", [
        kv([
          ["Hostname", f["hostname"], true],
          ["Certificate", f["hasCertificate"]],
          ["Force SSL", f["forceSsl"]],
          ["bunny.net hostname", f["isSystem"]],
        ]),
      ]),
    ],
    headerActions:
      f["isSystem"] === true
        ? []
        : [
            act("Request free certificate", "load-certificate", {
              success: "Certificate requested",
            }),
          ],
  };
}

function renderEdgeRule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Edge rule",
    status: {
      kind: "status-dot",
      status: f["enabled"] === false ? "info" : "healthy",
      label: f["enabled"] === false ? "Disabled" : "Enabled",
    },
    sections: [
      section("Rule", [
        kv([
          ["Action", f["action"]],
          ["Parameter", f["actionParameter1"]],
          ["Second parameter", f["actionParameter2"]],
          ["Trigger", f["triggerType"]],
          ["Patterns", f["triggerPatterns"]],
          ["Trigger parameter", f["triggerParameter"]],
          ["Matching", f["matchType"]],
          ["Triggers", f["triggerCount"]],
        ]),
        muted(
          "Rules with several triggers or extra actions keep them when edited here; only the first trigger is editable.",
        ),
      ]),
    ],
  };
}

function renderStorageZone(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Storage zone", str(f["region"]), str(f["tier"])),
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Storage zone", [
        kv([
          ["Main region", f["region"]],
          ["Replication regions", f["replicationRegions"] || "None"],
          ["Tier", f["tier"]],
          ["Used", bytes(f["storageUsed"])],
          ["Files", f["filesStored"]],
          ["Connected pull zones", f["pullZones"]],
          ["Rewrite 404 to 200", f["rewrite404To200"]],
          ["Custom 404 file", f["custom404FilePath"]],
        ]),
      ]),
      section("Access", [
        kv([
          ["Storage API / FTP host", f["storageHostname"], true],
          ["S3 hostname", f["s3Hostname"], true],
          ["Username", r.displayName, true],
        ]),
        muted("The password is the zone's Password output."),
      ]),
    ],
    storageBrowser: { bucketName: r.displayName },
    headerActions: [
      act("Reset password", "reset-password", {
        danger: true,
        confirm:
          "Generate a new storage zone password? FTP clients and apps using the old password stop working.",
        success: "Password reset",
      }),
      link("Open in dashboard", `${DASH}/storage/${r.externalId ?? ""}/storage`),
    ],
  };
}

function renderDnsZone(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "DNS zone",
    status: {
      kind: "status-dot",
      status: f["nameserversDetected"] === true ? "healthy" : "degraded",
      label:
        f["nameserversDetected"] === true
          ? "Nameservers detected"
          : "Nameservers not pointed at bunny.net",
    },
    sections: [
      section("Zone", [
        kv([
          ["Nameservers", [f["nameserver1"], f["nameserver2"]].filter(Boolean).join(", ")],
          ["Nameservers detected", f["nameserversDetected"]],
          ["Records", f["recordCount"]],
          ["SOA email", f["soaEmail"]],
          ["DNSSEC", f["dnssec"]],
          ["Query logging", f["logging"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
    ],
    childTables: [
      {
        title: "Records",
        typeId: "dns-record",
        onRowClick: "edit",
        columns: [
          {
            key: "type",
            label: "Type",
            source: { kind: "field", fieldKey: "type" },
            format: "type-badge",
          },
          {
            key: "name",
            label: "Name",
            source: { kind: "field", fieldKey: "name" },
            format: "mono",
          },
          {
            key: "value",
            label: "Value",
            width: "wide",
            source: { kind: "field", fieldKey: "content" },
            format: "mono",
          },
          { key: "ttl", label: "TTL", source: { kind: "field", fieldKey: "ttl" }, format: "ttl" },
        ],
      },
    ],
    headerActions: [link("Open in dashboard", `${DASH}/dns/${r.externalId ?? ""}/records`)],
  };
}

function renderLibrary(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Stream library",
    sections: [
      section("Library", [
        kv([
          ["Library ID", r.externalId, true],
          ["Videos", f["videoCount"]],
          ["Storage", bytes(f["storageUsage"])],
          ["Traffic", bytes(f["trafficUsage"])],
          ["Replication regions", f["replicationRegions"]],
          ["Resolutions", f["resolutions"]],
          ["MP4 fallback", f["mp4Fallback"]],
          ["Keep originals", f["keepOriginals"]],
          ["Direct play", f["directPlay"]],
          ["Transcribing", f["transcribing"]],
          ["Token authentication", f["tokenAuthentication"]],
          ["Block direct URL access", f["blockNoReferrer"]],
          ["DRM", f["drm"]],
          ["Webhook", f["webhookUrl"]],
        ]),
      ]),
    ],
    headerActions: [
      act("Reset API key", "reset-api-key", {
        danger: true,
        confirm: "Generate a new library API key? Apps using the old key stop working.",
        success: "API key reset",
      }),
      link("Open in dashboard", `${DASH}/stream/${r.externalId ?? ""}/library/videos`),
    ],
  };
}

function renderScript(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Edge script", str(f["scriptType"])),
    sections: [
      section("Script", [
        kv([
          ["Hostname", f["defaultHostname"], true],
          ["Type", f["scriptType"]],
          ["Linked pull zones", f["linkedPullZones"]],
          ["Current release", f["currentReleaseId"]],
          ["Requests this month", f["monthlyRequests"]],
          [
            "CPU time this month",
            f["monthlyCpuTime"] !== undefined ? `${str(f["monthlyCpuTime"])} ms` : "",
          ],
          ["Cost this month", usd(f["monthlyCost"])],
          ["Modified", f["lastModified"]],
        ]),
      ]),
    ],
    headerActions: [
      act("Publish latest code", "publish", {
        confirm: "Publish the script's latest saved code as a new release?",
        success: "Published",
      }),
      link("Open in dashboard", `${DASH}/scripts/${r.externalId ?? ""}`),
    ],
  };
}

function renderApp(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const s = str(f["status"]).toLowerCase();
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Magic Containers app", str(f["runtimeType"])),
    status: {
      kind: "status-dot",
      status:
        s === "active"
          ? "healthy"
          : s === "progressing"
            ? "provisioning"
            : s === "failing" || s === "suspended"
              ? "error"
              : "info",
      label: str(f["status"]) || "unknown",
    },
    sections: [
      section("App", [
        kv([
          ["Endpoint", f["endpoint"], true],
          ["Images", f["images"]],
          ["Instances", f["instances"]],
          ["Regions", f["regions"]],
          [
            "Autoscaling",
            f["minInstances"] !== undefined
              ? `${str(f["minInstances"])} to ${str(f["maxInstances"])} instances`
              : "",
          ],
        ]),
      ]),
    ],
    headerActions: [
      act("Restart", "restart", { success: "Restarting" }),
      act("Deploy", "deploy", { success: "Deploying" }),
      act("Undeploy", "undeploy", {
        danger: true,
        confirm: "Undeploy this app? It stops serving until deployed again.",
        success: "Undeployed",
      }),
      link("Open in dashboard", `${DASH}/containers/${r.externalId ?? ""}`),
    ],
  };
}

export function renderBunnyDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "account":
      schema = renderAccount(r);
      break;
    case "pull-zone":
      schema = renderPullZone(r);
      break;
    case "hostname":
      schema = renderHostname(r);
      break;
    case "edge-rule":
      schema = renderEdgeRule(r);
      break;
    case "storage-zone":
      schema = renderStorageZone(r);
      break;
    case "dns-zone":
      schema = renderDnsZone(r);
      break;
    case "dns-record":
      schema = renderDnsRecordDetail(r);
      break;
    case "video-library":
      schema = renderLibrary(r);
      break;
    case "edge-script":
      schema = renderScript(r);
      break;
    case "container-app":
      schema = renderApp(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderBunnySidebar(r: ResourceInstance): SidebarItemSchema {
  if (r.resourceTypeId === "dns-record") return renderDnsRecordSidebar(r);
  if (r.resourceTypeId === "pull-zone") {
    const s =
      r.fields["suspended"] === true ? "error" : r.fields["enabled"] === false ? "info" : "healthy";
    return { id: r.id, label: r.displayName || r.id, status: { kind: "status-dot", status: s } };
  }
  return { id: r.id, label: r.displayName || r.externalId || r.id };
}
