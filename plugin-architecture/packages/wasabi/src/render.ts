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
import { endpointFor } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { DEFAULT_METRICS_WINDOW_MS, PRICING_AS_OF, usdPerTbMonth } from "./usage.js";

const CONSOLE = "https://console.wasabisys.com";

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

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const today = new Date().toISOString().slice(0, 10);
  return {
    title: r.displayName,
    subtitle: "Wasabi account",
    sections: [
      section("Usage", [
        kv([
          ["Account number", f["acctNum"], true],
          ["Buckets", f["bucketCount"]],
          [
            "Active storage",
            f["activeStorageGib"] !== undefined ? `${str(f["activeStorageGib"])} GiB` : "",
          ],
          [
            "Timed deleted storage",
            f["deletedStorageGib"] !== undefined ? `${str(f["deletedStorageGib"])} GiB` : "",
          ],
          ["Objects", f["objects"]],
          [
            "Estimated monthly cost",
            f["estimatedMonthlyUsd"] !== undefined ? `$${str(f["estimatedMonthlyUsd"])}` : "",
          ],
          ["As of", f["utilizationDate"]],
          ["Account Control (sub-accounts)", f["subAccounts"]],
        ]),
        muted(
          `Estimated at pay-as-you-go list price, $${usdPerTbMonth(today)}/TB per month (1 TB = 1,024 GiB), with no egress or API fees (rates as of ${PRICING_AS_OF}). Reserved Capacity Storage is billed differently.`,
        ),
      ]),
    ],
    headerActions: [link("Open console", CONSOLE), link("Billing", `${CONSOLE}/#/billing`)],
  };
}

function renderBucket(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const name = str(f["name"]) || r.displayName;
  const region = str(f["region"]);
  return {
    title: name,
    subtitle: joinSubtitle("Wasabi bucket", region),
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Bucket", [
        kv([
          ["Region", region],
          ["Created", f["createdAt"]],
          ["Versioning", f["versioning"]],
          ["Object Lock", f["objectLock"]],
          [
            "Default retention",
            f["objectLock"] === true
              ? f["retentionMode"] && f["retentionMode"] !== "none"
                ? `${str(f["retentionMode"])}, ${str(f["retentionDays"])} days`
                : "None"
              : "",
          ],
          ["Tags", f["tags"]],
          [
            "Active storage",
            f["activeStorageGib"] !== undefined ? `${str(f["activeStorageGib"])} GiB` : "",
          ],
          ["Objects", f["objects"]],
        ]),
      ]),
      section("S3 access", [
        kv([
          ["Endpoint", endpointFor(region), true],
          ["Region", region, true],
          ["Bucket", name, true],
        ]),
        muted("Use Get credentials to create an IAM user and access key limited to this bucket."),
      ]),
    ],
    customTabs: [
      { id: "rules", label: "Rules", childResourceTypeIds: ["lifecycle-rule", "cors-rule"] },
    ],
    childTables: [
      {
        title: "Lifecycle rules",
        typeId: "lifecycle-rule",
        onRowClick: "edit",
        columns: [
          { key: "id", label: "Rule", source: { kind: "field", fieldKey: "ruleId" } },
          {
            key: "prefix",
            label: "Prefix",
            source: { kind: "field", fieldKey: "prefix" },
            format: "mono",
          },
          {
            key: "exp",
            label: "Expire after (days)",
            source: { kind: "field", fieldKey: "expirationDays" },
          },
          {
            key: "nc",
            label: "Previous versions (days)",
            source: { kind: "field", fieldKey: "noncurrentDays" },
          },
          {
            key: "on",
            label: "Enabled",
            source: { kind: "field", fieldKey: "enabled" },
            format: "boolean-yesno",
          },
        ],
      },
      {
        title: "CORS rules",
        typeId: "cors-rule",
        onRowClick: "edit",
        columns: [
          { key: "id", label: "Rule", source: { kind: "field", fieldKey: "ruleId" } },
          {
            key: "origins",
            label: "Origins",
            source: { kind: "field", fieldKey: "allowedOrigins" },
          },
          {
            key: "methods",
            label: "Methods",
            source: { kind: "field", fieldKey: "allowedMethods" },
          },
        ],
      },
    ],
    storageBrowser: { bucketName: name },
    bucketPolicyEditor: { bucketArn: `arn:aws:s3:::${name}`, bucketName: name, vendor: "aws-s3" },
    headerActions: [
      link("Open in console", `${CONSOLE}/#/file_manager/${encodeURIComponent(name)}`),
    ],
  };
}

function renderLifecycle(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Lifecycle rule", str(f["bucket"])),
    status: {
      kind: "status-dot",
      status: f["enabled"] === false ? "info" : "healthy",
      label: f["enabled"] === false ? "Disabled" : "Enabled",
    },
    sections: [
      section("Rule", [
        kv([
          ["Bucket", f["bucket"]],
          [
            "Applies to",
            f["prefix"] ? `Objects starting with ${str(f["prefix"])}` : "Every object",
          ],
          [
            "Expire current versions after",
            f["expirationDays"] !== undefined ? `${str(f["expirationDays"])} days` : "Never",
          ],
          [
            "Expire previous versions after",
            f["noncurrentDays"] !== undefined ? `${str(f["noncurrentDays"])} days` : "Never",
          ],
          [
            "Abort incomplete uploads after",
            f["abortMultipartDays"] !== undefined
              ? `${str(f["abortMultipartDays"])} days`
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
    subtitle: joinSubtitle("CORS rule", str(f["bucket"])),
    sections: [
      section("Rule", [
        kv([
          ["Bucket", f["bucket"]],
          ["Allowed origins", f["allowedOrigins"]],
          ["Allowed methods", f["allowedMethods"]],
          ["Allowed headers", f["allowedHeaders"]],
          ["Exposed headers", f["exposeHeaders"]],
          ["Max age", f["maxAgeSeconds"] !== undefined ? `${str(f["maxAgeSeconds"])} s` : ""],
        ]),
      ]),
    ],
  };
}

function renderUser(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "IAM user",
    sections: [
      section("User", [
        kv([
          ["ARN", f["arn"], true],
          ["User ID", f["userId"], true],
          ["Created", f["createdAt"]],
          ["Attached policies", f["policies"] || "None"],
          ["Inline policies", f["inlinePolicies"]],
          ["Groups", f["groups"]],
          ["Access keys", f["accessKeyCount"]],
        ]),
        muted("Get credentials creates a new access key; Wasabi shows its secret only once."),
      ]),
    ],
    headerActions: [link("Open in console", `${CONSOLE}/#/users`)],
  };
}

function renderKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const active = str(f["status"]) === "Active";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Access key", str(f["userName"])),
    status: {
      kind: "status-dot",
      status: active ? "healthy" : "info",
      label: str(f["status"]) || "Unknown",
    },
    sections: [
      section("Key", [
        kv([
          ["Access key ID", f["accessKeyId"], true],
          ["User", f["userName"]],
          ["Status", f["status"]],
          ["Created", f["createdAt"]],
          ["Last used", f["lastUsedAt"] || "Never"],
        ]),
      ]),
    ],
    headerActions: [
      active
        ? {
            kind: "action",
            label: "Deactivate",
            variant: "danger",
            action: {
              type: "plugin-action",
              actionId: "deactivate",
              confirmMessage:
                "Deactivate this access key? Anything using it stops authenticating until it is activated again.",
              successMessage: "Access key deactivated",
            },
          }
        : {
            kind: "action",
            label: "Activate",
            action: {
              type: "plugin-action",
              actionId: "activate",
              successMessage: "Access key activated",
            },
          },
    ],
  };
}

function renderSubAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Sub-account", str(f["acctNum"])),
    status: {
      kind: "status-dot",
      status: f["inactive"] === true ? "info" : "healthy",
      label: f["inactive"] === true ? "Inactive" : f["isTrial"] === true ? "Trial" : "Active",
    },
    sections: [
      section("Sub-account", [
        kv([
          ["Account number", f["acctNum"], true],
          ["Root user", f["acctName"]],
          ["Trial", f["isTrial"]],
          ["Trial expires", f["isTrial"] === true ? f["trialExpiry"] : ""],
          ["Trial quota", f["isTrial"] === true && f["quotaGb"] ? `${str(f["quotaGb"])} GB` : ""],
          ["Inactive", f["inactive"]],
          ["FTP/FTPS", f["enableFtp"]],
          ["MFA", f["mfa"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
    ],
    headerActions: [
      ...(f["isTrial"] === true
        ? [
            {
              kind: "action" as const,
              label: "Convert to paid",
              action: {
                type: "plugin-action" as const,
                actionId: "convert-to-paid",
                confirmMessage:
                  "Convert this trial sub-account to a paid account? This cannot be undone.",
                successMessage: "Converted to a paid account",
              },
            },
          ]
        : []),
      {
        kind: "action",
        label: "Reset access keys",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "reset-access-keys",
          destructive: true,
          confirmMessage:
            "Invalidate every access key of this sub-account and generate a new root key pair? Applications using the old keys stop working.",
          successMessage: "Access keys reset",
        },
      },
    ],
  };
}

export function renderWasabiDetail(r: ResourceInstance): DetailViewSchema {
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
    case "iam-user":
      schema = renderUser(r);
      break;
    case "access-key":
      schema = renderKey(r);
      break;
    case "sub-account":
      schema = renderSubAccount(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderWasabiSidebar(r: ResourceInstance): SidebarItemSchema {
  if (r.resourceTypeId === "access-key") {
    return {
      id: r.id,
      label: r.displayName || r.id,
      status: { kind: "status-dot", status: r.fields["status"] === "Active" ? "healthy" : "info" },
    };
  }
  return { id: r.id, label: r.displayName || r.externalId || r.id };
}
