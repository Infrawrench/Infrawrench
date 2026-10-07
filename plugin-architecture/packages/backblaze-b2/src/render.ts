import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";
import { DEFAULT_METRICS_WINDOW_MS, PRICING_AS_OF, STORAGE_USD_PER_TB_MONTH } from "./usage.js";

const CONSOLE = "https://secure.backblaze.com";

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
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

function visibilityLabel(v: unknown): string {
  return v === "allPublic" ? "Public" : v === "allPrivate" ? "Private" : str(v);
}

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Backblaze B2 account", str(f["s3Region"])),
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Account", [
        kv([
          ["Account ID", f["accountId"], true],
          ["Region", f["s3Region"]],
          ["S3 endpoint", f["s3Endpoint"], true],
          ["Buckets", f["bucketCount"]],
          ["Usage reports", f["usageReports"]],
        ]),
      ]),
      section("This application key", [
        kv([
          ["Capabilities", f["capabilities"]],
          ["Restricted to", f["keyRestrictedTo"] || "All buckets"],
          ["File name prefix", f["namePrefix"]],
          ["Expires", f["keyExpiresAt"] || "Never"],
        ]),
      ]),
      section("Spend", [
        muted(
          `Usage and estimated spend come from Backblaze's daily usage reports, priced at list ($${STORAGE_USD_PER_TB_MONTH}/TB-month storage, downloads free up to 3x stored, Class A to C calls free; rates as of ${PRICING_AS_OF}). Backblaze support turns the reports on per account.`,
        ),
      ]),
    ],
    headerActions: [
      link("Buckets", `${CONSOLE}/b2_buckets.htm`),
      link("Application keys", `${CONSOLE}/app_keys.htm`),
      link("Billing", `${CONSOLE}/billing.htm`),
    ],
  };
}

function renderBucket(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const name = str(f["name"]) || r.displayName;
  const lock = f["objectLock"] === true;
  return {
    title: name,
    subtitle: joinSubtitle("B2 bucket", visibilityLabel(f["bucketType"]), str(f["s3Region"])),
    status: {
      kind: "status-dot",
      status: f["bucketType"] === "allPublic" ? "degraded" : "healthy",
      label: visibilityLabel(f["bucketType"]),
    },
    sections: [
      section("Bucket", [
        kv([
          ["Bucket ID", f["bucketId"], true],
          ["Visibility", visibilityLabel(f["bucketType"])],
          [
            "Default encryption",
            f["encryption"] === "SSE-B2"
              ? "SSE-B2 (AES-256)"
              : f["encryption"] === "none"
                ? "Off"
                : "",
          ],
          ["Object Lock", f["objectLock"]],
          [
            "Default retention",
            lock && f["retentionMode"] && f["retentionMode"] !== "none"
              ? `${str(f["retentionMode"])}, ${str(f["retentionDays"])} days`
              : lock
                ? "None"
                : "",
          ],
          ["Default Cache-Control", f["cacheControl"]],
          ["Lifecycle rules", f["lifecycleRuleCount"]],
          ["CORS rules", f["corsRuleCount"]],
          ["Replication rules", f["replicationRuleCount"]],
          ["Replication destination", f["isReplicationDestination"]],
          ["Options", f["options"]],
        ]),
      ]),
      section("S3-compatible access", [
        kv([
          [
            "Endpoint",
            f["s3Region"] ? `https://s3.${str(f["s3Region"])}.backblazeb2.com` : "",
            true,
          ],
          ["Region", f["s3Region"], true],
          ["Bucket", name, true],
        ]),
        muted(
          "Use Get credentials to mint an application key limited to this bucket; its key ID and secret work as an S3 access key pair.",
        ),
      ]),
    ],
    customTabs: [
      {
        id: "rules",
        label: "Rules",
        childResourceTypeIds: [
          "lifecycle-rule",
          "cors-rule",
          "replication-rule",
          "notification-rule",
        ],
      },
    ],
    childTables: [
      {
        title: "Lifecycle rules",
        typeId: "lifecycle-rule",
        onRowClick: "edit",
        emptyText: "No lifecycle rules: every version of every file is kept until you delete it.",
        columns: [
          {
            key: "prefix",
            label: "Prefix",
            source: { kind: "field", fieldKey: "fileNamePrefix" },
            format: "mono",
          },
          {
            key: "hide",
            label: "Hide after (days)",
            source: { kind: "field", fieldKey: "daysFromUploadingToHiding" },
          },
          {
            key: "delete",
            label: "Delete hidden after (days)",
            source: { kind: "field", fieldKey: "daysFromHidingToDeleting" },
          },
        ],
      },
      {
        title: "CORS rules",
        typeId: "cors-rule",
        onRowClick: "edit",
        columns: [
          { key: "name", label: "Name", source: { kind: "display-name" } },
          {
            key: "origins",
            label: "Origins",
            source: { kind: "field", fieldKey: "allowedOrigins" },
          },
          {
            key: "ops",
            label: "Operations",
            source: { kind: "field", fieldKey: "allowedOperations" },
          },
        ],
      },
      {
        title: "Replication rules",
        typeId: "replication-rule",
        onRowClick: "edit",
        columns: [
          { key: "name", label: "Name", source: { kind: "display-name" } },
          {
            key: "dest",
            label: "Destination",
            source: { kind: "field", fieldKey: "destinationBucketName" },
          },
          {
            key: "enabled",
            label: "Enabled",
            source: { kind: "field", fieldKey: "isEnabled" },
            format: "boolean-yesno",
          },
        ],
      },
      {
        title: "Event notifications",
        typeId: "notification-rule",
        onRowClick: "navigate",
        columns: [
          { key: "name", label: "Name", source: { kind: "display-name" } },
          {
            key: "url",
            label: "Webhook",
            source: { kind: "field", fieldKey: "url" },
            format: "mono",
          },
          { key: "events", label: "Events", source: { kind: "field", fieldKey: "eventTypes" } },
          {
            key: "enabled",
            label: "Enabled",
            source: { kind: "field", fieldKey: "isEnabled" },
            format: "boolean-yesno",
          },
        ],
      },
    ],
    storageBrowser: { bucketName: name },
    headerActions: [link("Open in console", `${CONSOLE}/b2_buckets.htm`)],
  };
}

function renderLifecycle(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Lifecycle rule", str(f["bucketName"])),
    sections: [
      section("Rule", [
        kv([
          ["Bucket", f["bucketName"]],
          [
            "Applies to",
            f["fileNamePrefix"] ? `Files starting with ${str(f["fileNamePrefix"])}` : "Every file",
          ],
          [
            "Hide current version after",
            f["daysFromUploadingToHiding"] !== undefined
              ? `${str(f["daysFromUploadingToHiding"])} days`
              : "Never",
          ],
          [
            "Delete hidden versions after",
            f["daysFromHidingToDeleting"] !== undefined
              ? `${str(f["daysFromHidingToDeleting"])} days`
              : "Never",
          ],
          [
            "Cancel unfinished large files after",
            f["daysFromStartingToCancelingUnfinishedLargeFiles"] !== undefined
              ? `${str(f["daysFromStartingToCancelingUnfinishedLargeFiles"])} days`
              : "Never",
          ],
        ]),
      ]),
    ],
  };
}

function renderCors(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("CORS rule", str(f["bucketName"])),
    sections: [
      section("Rule", [
        kv([
          ["Bucket", f["bucketName"]],
          ["Allowed origins", f["allowedOrigins"]],
          ["Allowed operations", f["allowedOperations"]],
          ["Allowed headers", f["allowedHeaders"]],
          ["Exposed headers", f["exposeHeaders"]],
          ["Max age", f["maxAgeSeconds"] !== undefined ? `${str(f["maxAgeSeconds"])} s` : ""],
        ]),
      ]),
    ],
  };
}

function renderReplication(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Replication rule", str(f["bucketName"])),
    status: {
      kind: "status-dot",
      status: f["isEnabled"] === false ? "info" : "healthy",
      label: f["isEnabled"] === false ? "Disabled" : "Enabled",
    },
    sections: [
      section("Rule", [
        kv([
          ["Source bucket", f["bucketName"]],
          ["Destination bucket", f["destinationBucketName"] || f["destinationBucketId"]],
          ["File name prefix", f["fileNamePrefix"] || "Every file"],
          ["Priority", f["priority"]],
          ["Enabled", f["isEnabled"]],
          ["Includes existing files", f["includeExistingFiles"]],
        ]),
        muted(
          "Replication status per file is reported in the X-Bz-Replication-Status header of each file.",
        ),
      ]),
    ],
  };
}

function renderNotification(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const suspended = f["isSuspended"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Event notification", str(f["bucketName"])),
    status: {
      kind: "status-dot",
      status: suspended ? "error" : f["isEnabled"] === false ? "info" : "healthy",
      label: suspended ? "Suspended" : f["isEnabled"] === false ? "Disabled" : "Enabled",
    },
    sections: [
      section("Rule", [
        kv([
          ["Bucket", f["bucketName"]],
          ["Webhook URL", f["url"], true],
          ["Event types", f["eventTypes"]],
          ["Object name prefix", f["objectNamePrefix"] || "Every object"],
          ["Events per call", f["maxEventsPerBatch"]],
          ["Custom headers", f["customHeaders"]],
          ["Suspension reason", suspended ? f["suspensionReason"] : ""],
        ]),
        muted(
          "Each call is signed with the rule's signing secret in X-Bz-Event-Notification-Signature. Reveal it from the outputs.",
        ),
      ]),
    ],
    headerActions: [
      ...(suspended
        ? [
            {
              kind: "action" as const,
              label: "Re-enable",
              action: {
                type: "plugin-action" as const,
                actionId: "resume-notification",
                successMessage: "Rule re-enabled",
              },
            },
          ]
        : []),
    ],
  };
}

function renderKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Application key", str(f["applicationKeyId"])),
    sections: [
      section("Key", [
        kv([
          ["Key ID", f["applicationKeyId"], true],
          ["Capabilities", f["capabilities"]],
          ["Buckets", f["bucketNames"] || "All buckets"],
          ["File name prefix", f["namePrefix"]],
          ["Expires", f["expiresAt"] || "Never"],
          ["Can manage keys or delete buckets", f["isAdmin"]],
        ]),
        muted(
          "B2 only shows a key's secret when it is created. Keys created here keep their secret in the Application Key output; older keys can only be replaced.",
        ),
      ]),
    ],
  };
}

export function renderB2Detail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "account":
      schema = renderAccount(r);
      break;
    case "bucket":
      schema = renderBucket(r);
      break;
    case "lifecycle-rule":
      schema = renderLifecycle(r);
      break;
    case "cors-rule":
      schema = renderCors(r);
      break;
    case "replication-rule":
      schema = renderReplication(r);
      break;
    case "notification-rule":
      schema = renderNotification(r);
      break;
    case "application-key":
      schema = renderKey(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderB2Sidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  if (r.resourceTypeId === "bucket") {
    return {
      id: r.id,
      label: r.displayName || "bucket",
      status: {
        kind: "status-dot",
        status: f["bucketType"] === "allPublic" ? "degraded" : "healthy",
      },
    };
  }
  if (r.resourceTypeId === "notification-rule" && f["isSuspended"] === true) {
    return {
      id: r.id,
      label: r.displayName || r.id,
      status: { kind: "status-dot", status: "error" },
    };
  }
  return { id: r.id, label: r.displayName || r.externalId || r.id };
}
