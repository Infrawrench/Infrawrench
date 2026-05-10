import type {
  DetailViewSchema,
  DetailViewTab,
  ResourceInstance,
  ResourceTypeDefinition,
  SqlTableMeta,
  SchemaNode,
  SectionNode,
  HostAction,
  TextNode,
  KeyValueListNode,
  TableNode,
  ActionNode,
} from "@infrawrench/plugin-base";
import { labeledFieldItems, dnsRecordBadgeColor, formatDnsTtl } from "@infrawrench/plugin-base";
import { gcpStatus } from "./utils.js";
import type {
  FirestoreIndexSummary,
  FirestoreBackupSchedule,
  FirestoreTtlConfig,
  FirestoreOperation,
  FirestoreRulesInfo,
  FirestoreBackupInfo,
  FirestoreDatabaseExtras,
  FirestoreUsageMetrics,
  FirestoreIamInfo,
} from "./firestore-handlers.js";
import type {
  CloudRunRevisionSummary,
  CloudRunIamInfo,
  CloudRunTriggerSummary,
  CloudRunFullServiceResult,
  CloudRunDomainMappingsResult,
} from "./cloud-run-handlers.js";

interface BigQuerySchemaField {
  name?: unknown;
  type?: unknown;
  mode?: unknown;
  description?: unknown;
  fields?: unknown;
}

export interface GcpDetailContext {
  id(accountId: string, typeId: string, externalId: string): string;
  project: string;
  resourceTypes: ResourceTypeDefinition[];
}

/**
 * Heuristic: is the given error message about missing IAM permissions?
 * Used to decide whether to show the "grant role X to the SA" advisory.
 */
function isPermissionError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("permission") ||
    lower.includes("caller does not have") ||
    lower.includes("forbidden") ||
    lower.includes("access denied")
  );
}

/**
 * Truncate a container image reference for table display. Keeps the registry
 * + repo path and shortens any sha256 digest to the first 12 characters.
 */
function shortImage(image: string): string {
  if (!image) return "—";
  const at = image.indexOf("@sha256:");
  if (at < 0) return image;
  const digest = image.slice(at + "@sha256:".length).slice(0, 12);
  return `${image.slice(0, at)}@${digest}`;
}

/** Format a bytes count (string from the API or number) as e.g. "42.3 MB". */
function formatBackupSize(bytes: string | number): string {
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i] ?? "B"}`;
}

/** Format an ISO timestamp as a relative "5 min ago" / "2 days ago" string. */
function formatRelativeTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Turn a protobuf Duration string like "604800s" into "7 days". */
function formatPitrRetention(duration: string): string {
  const m = /^(\d+)s$/.exec(duration);
  if (!m) return duration || "—";
  const secs = Number(m[1]);
  if (!Number.isFinite(secs)) return duration;
  const days = secs / 86400;
  if (days >= 1) return `${days.toFixed(days === Math.floor(days) ? 0 : 1)} days`;
  const hours = secs / 3600;
  return `${hours.toFixed(hours === Math.floor(hours) ? 0 : 1)} hours`;
}

function bigQuerySchemaToRows(
  schemaJson: string,
): Array<{ cells: Record<string, string>; depth?: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: Array<{ cells: Record<string, string>; depth?: number }> = [];
  const walk = (fields: unknown[], depth: number) => {
    for (const raw of fields) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as BigQuerySchemaField;
      const type = typeof f.type === "string" ? f.type : "";
      const mode = typeof f.mode === "string" ? f.mode : "NULLABLE";
      rows.push({
        cells: {
          name: typeof f.name === "string" ? f.name : "",
          type,
          mode,
          description: typeof f.description === "string" ? f.description : "",
        },
        depth,
      });
      if ((type === "RECORD" || type === "STRUCT") && Array.isArray(f.fields)) {
        walk(f.fields, depth + 1);
      }
    }
  };
  walk(parsed, 0);
  return rows;
}

/**
 * Bundled inputs needed to render Cloud Run-style detail views (Service info,
 * Revisions, Networking, Security, Source, Triggers tabs). Cloud Functions
 * (gen2) services are backed by Cloud Run and can reuse the same helpers by
 * parsing their own resolvedOutputs into this shape.
 */
export interface CloudRunDetailInput {
  // Parsed JSON blobs from resolvedOutputs.
  fullService: Record<string, unknown>;
  fullServiceError: string;
  revisions: CloudRunRevisionSummary[];
  triggers: CloudRunTriggerSummary[];
  iam: CloudRunIamInfo;
  domainMappings: CloudRunDomainMappingsResult;
  // Plain string fields (typically from resource.fields / resolvedOutputs).
  url: string;
  region: string;
  name: string;
  ingress: string;
  lastModifier: string;
  image: string;
  serviceAccount: string;
  latestRevision: string;
  deployClient: string;
  deployClientVersion: string;
  sourceLocation: string;
}

/** Build the "Service info" section shown above the tabs. */
function buildCloudRunServiceInfoSection(input: CloudRunDetailInput): SectionNode {
  const { url, region, latestRevision, lastModifier, image, serviceAccount } = input;
  return {
    kind: "section",
    title: "Service info",
    children: [
      {
        kind: "key-value-list",
        items: [
          ...(url ? [{ key: "URL", value: url, copyable: true }] : []),
          { key: "Region", value: region || "—" },
          { key: "Latest ready revision", value: latestRevision || "—" },
          ...(lastModifier ? [{ key: "Last modifier", value: lastModifier }] : []),
          ...(image ? [{ key: "Container image", value: image, copyable: true }] : []),
          ...(serviceAccount ? [{ key: "Service account", value: serviceAccount }] : []),
        ],
      },
    ],
  };
}

/** Build the "Revisions" tab listing every revision in a table. */
function buildCloudRunRevisionsTab(input: CloudRunDetailInput): DetailViewTab {
  const { revisions } = input;
  return {
    id: "cloud-run-revisions",
    label: "Revisions",
    sections:
      revisions.length === 0
        ? [
            {
              kind: "section",
              children: [
                {
                  kind: "text",
                  content: "No revisions found for this service.",
                  variant: "muted",
                },
              ],
            },
          ]
        : [
            {
              kind: "section",
              children: [
                {
                  kind: "table",
                  emphasizeFirstColumn: true,
                  columns: [
                    { key: "name", label: "Revision" },
                    { key: "traffic", label: "Traffic", width: "narrow" },
                    { key: "ready", label: "Ready", width: "narrow" },
                    { key: "image", label: "Image", mono: true, width: "wide" },
                    { key: "cpu", label: "CPU", width: "narrow" },
                    { key: "memory", label: "Memory", width: "narrow" },
                    { key: "env", label: "Env", width: "narrow" },
                    { key: "health", label: "Health", width: "narrow" },
                    { key: "created", label: "Created" },
                  ],
                  rows: revisions.map((r) => ({
                    cells: {
                      name: r.name,
                      traffic: r.trafficPercent ? `${r.trafficPercent}%` : "—",
                      ready: r.ready ? "Yes" : "No",
                      image: shortImage(r.image),
                      cpu: r.cpuLimit || "—",
                      memory: r.memoryLimit || "—",
                      env: String(r.envCount),
                      health: String(r.healthCheckCount),
                      created: r.createTime ? new Date(r.createTime).toLocaleString() : "—",
                    },
                  })),
                },
              ],
            },
          ],
  };
}

/** Build the "Networking" tab (ingress, endpoints, custom domains, VPC, mesh). */
function buildCloudRunNetworkingTab(input: CloudRunDetailInput): DetailViewTab {
  const { ingress, url, domainMappings, fullService } = input;
  const template = (fullService["template"] as Record<string, unknown> | undefined) ?? {};
  const vpcAccess = template["vpcAccess"] as Record<string, unknown> | undefined;
  const annotations = (fullService["annotations"] as Record<string, unknown> | undefined) ?? {};
  const meshAnnotation = String(annotations["run.googleapis.com/mesh"] ?? "");
  const defaultUriDisabled = Boolean(fullService["defaultUriDisabled"]);
  const currentConnector = String(vpcAccess?.["connector"] ?? "");
  const currentEgress = String(vpcAccess?.["egress"] ?? "");

  const ingressLabel =
    ingress === "INGRESS_TRAFFIC_ALL"
      ? "All — public"
      : ingress === "INGRESS_TRAFFIC_INTERNAL_ONLY"
        ? "Internal only"
        : ingress === "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
          ? "Internal + Load Balancer"
          : ingress || "—";

  const editIngressAction: HostAction = {
    type: "prompt-nosql-command",
    command: "editNetworking",
    title: "Edit ingress",
    fields: [
      {
        key: "ingress",
        label: "Ingress",
        kind: "select",
        required: true,
        defaultValue: ingress || "INGRESS_TRAFFIC_ALL",
        options: [
          { id: "INGRESS_TRAFFIC_ALL", label: "All — public" },
          { id: "INGRESS_TRAFFIC_INTERNAL_ONLY", label: "Internal only" },
          {
            id: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
            label: "Internal + Application Load Balancer",
          },
        ],
      },
    ],
    submitLabel: "Apply",
  };

  const editEndpointAction: HostAction = {
    type: "prompt-nosql-command",
    command: "editNetworking",
    title: "Edit default endpoint",
    description:
      "Disable to remove the *.run.app default URL. The service stays reachable via custom domains and load balancers.",
    fields: [
      {
        key: "defaultUri",
        label: "Default HTTPS endpoint URL",
        kind: "select",
        required: true,
        defaultValue: defaultUriDisabled ? "disabled" : "enabled",
        options: [
          { id: "enabled", label: "Enabled" },
          { id: "disabled", label: "Disabled" },
        ],
      },
    ],
    submitLabel: "Apply",
  };

  const editVpcAction: HostAction = {
    type: "prompt-nosql-command",
    command: "editNetworking",
    title: "Edit VPC",
    description: "Leave both fields blank to remove VPC access.",
    fields: [
      {
        key: "vpcConnector",
        label: "VPC connector",
        kind: "text",
        required: false,
        defaultValue: currentConnector,
        placeholder: "projects/PROJECT/locations/REGION/connectors/NAME",
        description: "Full resource path. Empty clears.",
      },
      {
        key: "vpcEgress",
        label: "VPC egress",
        kind: "select",
        required: false,
        defaultValue: currentEgress || "",
        options: [
          { id: "", label: "(no egress override)" },
          { id: "ALL_TRAFFIC", label: "All traffic" },
          { id: "PRIVATE_RANGES_ONLY", label: "Private ranges only" },
        ],
      },
    ],
    submitLabel: "Apply",
  };

  const editMeshAction: HostAction = {
    type: "prompt-nosql-command",
    command: "editNetworking",
    title: "Edit service mesh",
    description: "Sets the run.googleapis.com/mesh annotation. Leave blank to clear.",
    fields: [
      {
        key: "mesh",
        label: "Service mesh",
        kind: "text",
        required: false,
        defaultValue: meshAnnotation,
        placeholder: "projects/PROJECT/locations/REGION/meshes/NAME",
      },
    ],
    submitLabel: "Apply",
  };

  const networkingChildren: SchemaNode[] = [
    {
      kind: "section",
      title: "Ingress",
      children: [
        {
          kind: "key-value-list",
          items: [{ key: "Ingress traffic", value: ingressLabel }],
        },
        { kind: "action", label: "Edit ingress", action: editIngressAction },
      ],
    },
    {
      kind: "section",
      title: "Endpoints",
      children: [
        {
          kind: "key-value-list",
          items: [
            ...(url
              ? [{ key: "Default HTTPS URL", value: url, copyable: true }]
              : [{ key: "Default HTTPS URL", value: "(none)" }]),
            { key: "Status", value: defaultUriDisabled ? "Disabled" : "Enabled" },
          ],
        },
        { kind: "action", label: "Edit default endpoint", action: editEndpointAction },
      ],
    },
    {
      kind: "section",
      title: "Custom domains",
      children: domainMappings.error
        ? [
            { kind: "text", content: domainMappings.error, variant: "muted" },
            ...(isPermissionError(domainMappings.error)
              ? [
                  {
                    kind: "text" as const,
                    content:
                      "Grant roles/run.viewer to list domain mappings, or roles/run.admin to manage them.",
                    variant: "muted" as const,
                  },
                ]
              : []),
          ]
        : domainMappings.mappings.length === 0
          ? [
              {
                kind: "text",
                content:
                  "No custom domains. Use Map domain to map a fully-qualified hostname; Cloud Run will then return DNS records to add at your registrar.",
                variant: "muted",
              },
            ]
          : domainMappings.mappings.flatMap((m) => {
              const items: Array<TextNode | KeyValueListNode | TableNode | ActionNode> = [
                {
                  kind: "key-value-list",
                  items: [
                    {
                      key: m.domain,
                      value: m.ready ? "Ready" : m.status,
                      copyable: true,
                    },
                    ...(m.url ? [{ key: "URL", value: m.url, copyable: true }] : []),
                    ...(m.message && !m.ready ? [{ key: "Status detail", value: m.message }] : []),
                  ],
                },
              ];
              if (m.resourceRecords.length > 0) {
                items.push({
                  kind: "table",
                  columns: [
                    { key: "name", label: "Name", mono: true },
                    { key: "type", label: "Type", width: "narrow" },
                    { key: "value", label: "Value", mono: true, width: "wide" },
                  ],
                  rows: m.resourceRecords.map((r) => ({
                    cells: {
                      name: r.name || "@",
                      type: r.type,
                      value: r.rrdata,
                    },
                  })),
                });
              } else if (!m.ready) {
                items.push({
                  kind: "text",
                  content: "Cloud Run hasn't published DNS records yet — refresh in a few seconds.",
                  variant: "muted",
                });
              }
              items.push({
                kind: "action",
                label: `Delete ${m.domain}`,
                variant: "danger",
                action: {
                  type: "prompt-nosql-command",
                  command: "deleteDomainMapping",
                  title: `Delete domain mapping ${m.domain}?`,
                  description:
                    "Removes the mapping. The domain will stop routing to this service. DNS records you added at your registrar can be removed separately.",
                  fields: [
                    {
                      key: "domain",
                      label: "Domain",
                      kind: "text",
                      required: true,
                      defaultValue: m.domain,
                      hidden: true,
                    },
                  ],
                  submitLabel: "Delete mapping",
                  danger: true,
                },
              });
              return items;
            }),
    },
    {
      kind: "section",
      title: "VPC",
      children: [
        {
          kind: "key-value-list",
          items:
            vpcAccess && (vpcAccess["connector"] || vpcAccess["egress"])
              ? [
                  ...(vpcAccess["connector"]
                    ? [{ key: "Connector", value: String(vpcAccess["connector"]) }]
                    : []),
                  ...(vpcAccess["egress"]
                    ? [{ key: "Egress", value: String(vpcAccess["egress"]) }]
                    : []),
                ]
              : [{ key: "VPC", value: "Not configured" }],
        },
        { kind: "action", label: "Edit VPC", action: editVpcAction },
      ],
    },
    {
      kind: "section",
      title: "Service mesh",
      children: [
        {
          kind: "key-value-list",
          items: [{ key: "Mesh", value: meshAnnotation || "Not configured" }],
        },
        { kind: "action", label: "Edit service mesh", action: editMeshAction },
      ],
    },
  ];

  const mapDomainAction: HostAction = {
    type: "prompt-nosql-command",
    command: "createDomainMapping",
    title: "Map a custom domain",
    description:
      "Cloud Run will start provisioning a managed TLS certificate and return the DNS records you need to add at your registrar. Make sure the domain is verified for your account first (https://www.google.com/webmasters/verification).",
    fields: [
      {
        key: "domain",
        label: "Domain",
        kind: "text",
        required: true,
        placeholder: "app.example.com",
        description: "Fully-qualified hostname (apex or subdomain). Wildcards are not supported.",
      },
    ],
    submitLabel: "Map domain",
  };

  return {
    id: "cloud-run-networking",
    label: "Networking",
    sections: networkingChildren as SectionNode[],
    headerActions: [{ kind: "action", label: "+ Map domain", action: mapDomainAction }],
  };
}

/**
 * Build the "Security" tab (Authentication, IAM bindings, Binary Authorization,
 * Threat Detection).
 */
function buildCloudRunSecurityTab(input: CloudRunDetailInput): DetailViewTab {
  const { iam, fullService } = input;

  const addBindingAction: HostAction = {
    type: "prompt-nosql-command",
    command: "addIamBinding",
    title: "Add IAM binding",
    description:
      "Common roles: roles/run.invoker, roles/run.developer, roles/run.admin. Members use the IAM principal format, e.g. user:alice@example.com, serviceAccount:svc@…iam.gserviceaccount.com, group:eng@…, allUsers, allAuthenticatedUsers.",
    fields: [
      {
        key: "role",
        label: "Role",
        kind: "text",
        required: true,
        placeholder: "roles/run.invoker",
        defaultValue: "roles/run.invoker",
      },
      {
        key: "member",
        label: "Member",
        kind: "text",
        required: true,
        placeholder: "user:alice@example.com",
      },
    ],
    submitLabel: "Add",
  };

  const flatBindings = iam.bindings.flatMap((b) =>
    b.members.map((m) => {
      const colon = m.indexOf(":");
      return {
        role: b.role,
        type: colon > 0 ? m.slice(0, colon) : "principal",
        principal: colon > 0 ? m.slice(colon + 1) : m,
        raw: m,
      };
    }),
  );
  const securityChildren: SchemaNode[] = iam.error
    ? [
        { kind: "text", content: iam.error, variant: "muted" },
        ...(isPermissionError(iam.error)
          ? [
              {
                kind: "text" as const,
                content:
                  "Grant roles/run.viewer (read-only) or roles/run.admin (read/write) on this service to manage IAM bindings.",
                variant: "muted" as const,
              },
            ]
          : []),
      ]
    : flatBindings.length === 0
      ? [
          {
            kind: "text",
            content:
              "No IAM bindings on this service. Authentication is required by default; allUsers must be granted roles/run.invoker for public access.",
            variant: "muted",
          },
          { kind: "action", label: "+ Add binding", action: addBindingAction },
        ]
      : [
          {
            kind: "text",
            content:
              "Direct IAM bindings on this service. allUsers in roles/run.invoker = public service.",
            variant: "muted",
          },
          ...flatBindings.map<SchemaNode>((fb) => ({
            kind: "section",
            children: [
              {
                kind: "key-value-list",
                items: [
                  { key: "Role", value: fb.role.replace(/^roles\//, "") },
                  { key: "Principal", value: `${fb.type}:${fb.principal}` },
                ],
              },
              {
                kind: "action",
                label: "Remove",
                variant: "danger",
                action: {
                  type: "prompt-nosql-command",
                  command: "removeIamBinding",
                  title: `Remove ${fb.role.replace(/^roles\//, "")} binding?`,
                  description: `Removes ${fb.raw} from ${fb.role}.`,
                  fields: [
                    {
                      key: "role",
                      label: "Role",
                      kind: "text",
                      required: true,
                      defaultValue: fb.role,
                      hidden: true,
                    },
                    {
                      key: "member",
                      label: "Member",
                      kind: "text",
                      required: true,
                      defaultValue: fb.raw,
                      hidden: true,
                    },
                  ],
                  submitLabel: "Remove",
                  danger: true,
                },
              },
            ],
          })),
          { kind: "action", label: "+ Add binding", action: addBindingAction },
        ];

  // Authentication mode is derived from IAM: a service is "publicly
  // accessible" iff allUsers (or allAuthenticatedUsers) is in roles/run.invoker.
  const invokerBinding = iam.bindings.find((b) => b.role === "roles/run.invoker");
  const invokerMembers = invokerBinding?.members ?? [];
  const isPublic = invokerMembers.includes("allUsers");
  const isAllAuthenticated = invokerMembers.includes("allAuthenticatedUsers");

  const editAuthAction: HostAction = {
    type: "prompt-nosql-command",
    command: "editAuthMode",
    title: "Edit authentication",
    description:
      "Public access adds allUsers to roles/run.invoker; authenticated removes it. IAM-controlled principals are managed below.",
    fields: [
      {
        key: "mode",
        label: "Authentication",
        kind: "select",
        required: true,
        defaultValue: isPublic ? "public" : "authenticated",
        options: [
          { id: "public", label: "Allow public access" },
          { id: "authenticated", label: "Require authentication" },
        ],
      },
    ],
    submitLabel: "Apply",
  };

  const authChildren: SchemaNode[] = iam.error
    ? [{ kind: "text", content: "Cannot read auth mode — IAM fetch failed.", variant: "muted" }]
    : [
        {
          kind: "key-value-list",
          items: [
            {
              key: "Mode",
              value: isPublic
                ? "Allow public access (no authentication checks)"
                : isAllAuthenticated
                  ? "Require authentication — any Google-authenticated user"
                  : "Require authentication — IAM-controlled principals",
            },
            ...(invokerMembers.length > 0
              ? [
                  {
                    key: "Invokers",
                    value: invokerMembers.join(", "),
                  },
                ]
              : []),
          ],
        },
        { kind: "action", label: "Edit authentication", action: editAuthAction },
      ];

  // Binary Authorization is enabled when fullService.binaryAuthorization
  // is set (with either useDefault or an explicit policy).
  const binAuth = fullService["binaryAuthorization"] as Record<string, unknown> | undefined;
  const binAuthEnabled = !!binAuth && (binAuth["useDefault"] === true || !!binAuth["policy"]);
  const currentBinAuthMode =
    binAuth?.["useDefault"] === true ? "default" : binAuth?.["policy"] ? "custom" : "disabled";
  const editBinAuthAction: HostAction = {
    type: "prompt-nosql-command",
    command: "editBinaryAuthorization",
    title: "Edit Binary Authorization",
    description:
      "Binary Authorization gates deployments on attested container images. Custom policy uses the full resource path projects/PROJECT/policy.",
    fields: [
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        required: true,
        defaultValue: currentBinAuthMode,
        options: [
          { id: "disabled", label: "Disabled" },
          { id: "default", label: "Project default policy" },
          { id: "custom", label: "Custom policy" },
        ],
      },
      {
        key: "policy",
        label: "Custom policy",
        kind: "text",
        required: false,
        defaultValue: binAuth?.["policy"] ? String(binAuth["policy"]) : "",
        placeholder: "projects/PROJECT/policy",
        showWhen: { fieldKey: "mode", fieldValue: "custom" },
      },
    ],
    submitLabel: "Apply",
  };

  const binAuthChildren: SchemaNode[] = [
    {
      kind: "key-value-list",
      items: [
        { key: "Status", value: binAuthEnabled ? "Enabled" : "Disabled" },
        ...(binAuth?.["useDefault"] === true
          ? [{ key: "Policy", value: "Project default" }]
          : binAuth?.["policy"]
            ? [{ key: "Policy", value: String(binAuth["policy"]) }]
            : []),
        ...(binAuth?.["breakglassJustification"]
          ? [
              {
                key: "Breakglass justification",
                value: String(binAuth["breakglassJustification"]),
              },
            ]
          : []),
      ],
    },
    { kind: "action", label: "Edit Binary Authorization", action: editBinAuthAction },
  ];

  const threatChildren: SchemaNode[] = [
    {
      kind: "text",
      content:
        "Cloud Run threat detection is a project-level setting in Security Command Center, not a per-service control. Enable in the SCC console (cloud.google.com/security-command-center) to flag runtime threats across all Cloud Run services in this project.",
      variant: "muted",
    },
  ];

  return {
    id: "cloud-run-security",
    label: "Security",
    sections: [
      {
        kind: "section",
        title: "Authentication",
        children: authChildren,
      },
      {
        kind: "section",
        title: "IAM bindings",
        children: securityChildren,
      },
      {
        kind: "section",
        title: "Binary Authorization",
        children: binAuthChildren,
      },
      {
        kind: "section",
        title: "Threat Detection",
        children: threatChildren,
      },
    ],
  };
}

/** Build the "Source" tab (deployment metadata: image, modifier, build ID). */
function buildCloudRunSourceTab(input: CloudRunDetailInput): DetailViewTab {
  const { image, lastModifier, deployClient, deployClientVersion, sourceLocation, fullService } =
    input;
  const annotations = (fullService["annotations"] as Record<string, unknown> | undefined) ?? {};
  const buildId = String(annotations["run.googleapis.com/build-id"] ?? "");
  return {
    id: "cloud-run-source",
    label: "Source",
    sections: [
      {
        kind: "section",
        title: "Deployment",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Container image", value: image || "—", copyable: !!image },
              { key: "Last modifier", value: lastModifier || "—" },
              { key: "Deployed by", value: deployClient || "—" },
              ...(deployClientVersion
                ? [{ key: "Client version", value: deployClientVersion }]
                : []),
              ...(sourceLocation ? [{ key: "Source location", value: sourceLocation }] : []),
              ...(buildId ? [{ key: "Build ID", value: buildId }] : []),
            ],
          },
        ],
      },
    ],
  };
}

/** Build the "Triggers" tab listing Eventarc triggers pointed at the service. */
function buildCloudRunTriggersTab(input: CloudRunDetailInput): DetailViewTab {
  const { triggers } = input;

  const createTriggerAction: HostAction = {
    type: "prompt-nosql-command",
    command: "createTrigger",
    title: "Create Eventarc trigger",
    description:
      "Connect this service to an event source. The trigger's destination is set to this Cloud Run service automatically.",
    fields: [
      {
        key: "name",
        label: "Trigger name",
        kind: "text",
        required: true,
        placeholder: "my-trigger",
        description: "Lowercase letters, digits, and dashes (max 63 chars).",
      },
      {
        key: "eventSource",
        label: "Event source",
        kind: "select",
        required: true,
        defaultValue: "pubsub",
        options: [
          { id: "pubsub", label: "Pub/Sub message" },
          { id: "storage-finalized", label: "Cloud Storage — Object finalized" },
          { id: "storage-deleted", label: "Cloud Storage — Object deleted" },
          { id: "audit-log", label: "Cloud Audit Log entry" },
          { id: "custom", label: "Custom (advanced)" },
        ],
      },
      {
        key: "pubsubTopic",
        label: "Pub/Sub topic (optional)",
        kind: "resource-picker",
        required: false,
        description: "Leave blank to let Eventarc auto-create a topic.",
        showWhen: { fieldKey: "eventSource", fieldValue: "pubsub" },
        associationSources: [
          { pluginId: "gcp", resourceTypeId: "pubsub-topic", outputKey: "topicName" },
        ],
      },
      {
        key: "storageBucket",
        label: "GCS bucket",
        kind: "resource-picker",
        required: true,
        showWhen: { fieldKey: "eventSource", fieldValue: "storage-finalized" },
        associationSources: [
          { pluginId: "gcp", resourceTypeId: "gcs-bucket", outputKey: "bucketName" },
        ],
      },
      {
        key: "storageBucket",
        label: "GCS bucket",
        kind: "resource-picker",
        required: true,
        showWhen: { fieldKey: "eventSource", fieldValue: "storage-deleted" },
        associationSources: [
          { pluginId: "gcp", resourceTypeId: "gcs-bucket", outputKey: "bucketName" },
        ],
      },
      {
        key: "auditService",
        label: "Audit service name",
        kind: "text",
        required: true,
        placeholder: "compute.googleapis.com",
        showWhen: { fieldKey: "eventSource", fieldValue: "audit-log" },
      },
      {
        key: "auditMethod",
        label: "Audit method name",
        kind: "text",
        required: true,
        placeholder: "v1.compute.instances.delete",
        showWhen: { fieldKey: "eventSource", fieldValue: "audit-log" },
      },
      {
        key: "customType",
        label: "Event type",
        kind: "text",
        required: true,
        placeholder: "google.cloud.firestore.document.v1.created",
        showWhen: { fieldKey: "eventSource", fieldValue: "custom" },
      },
      {
        key: "customFilters",
        label: "Additional filters (JSON)",
        kind: "text",
        required: false,
        multiline: true,
        placeholder: '[{"attribute":"database","value":"(default)"}]',
        description: "Optional JSON array of {attribute, value} objects.",
        showWhen: { fieldKey: "eventSource", fieldValue: "custom" },
      },
      {
        key: "serviceAccount",
        label: "Service account (optional)",
        kind: "resource-picker",
        required: false,
        description: "Leave blank to use the default Compute SA.",
        associationSources: [
          { pluginId: "gcp", resourceTypeId: "gcp-service-account", outputKey: "email" },
        ],
      },
    ],
    submitLabel: "Create trigger",
  };

  return {
    id: "cloud-run-triggers",
    label: "Triggers",
    sections:
      triggers.length === 0
        ? [
            {
              kind: "section",
              children: [
                {
                  kind: "text",
                  content:
                    "No Eventarc triggers point at this service. Use Create trigger to wire one up to Pub/Sub, Cloud Storage, Audit Logs, or any custom event source.",
                  variant: "muted",
                },
                { kind: "action", label: "+ Create trigger", action: createTriggerAction },
              ],
            },
          ]
        : [
            {
              kind: "section",
              children: [
                {
                  kind: "table",
                  columns: [
                    { key: "name", label: "Trigger" },
                    { key: "eventType", label: "Event type", mono: true, width: "wide" },
                    { key: "transport", label: "Transport", width: "narrow" },
                    { key: "serviceAccount", label: "Service account", mono: true },
                    { key: "created", label: "Created" },
                  ],
                  rows: triggers.map((t) => ({
                    cells: {
                      name: t.name,
                      eventType: t.eventType || "—",
                      transport: t.transport || "—",
                      serviceAccount: t.serviceAccount || "—",
                      created: t.createTime ? new Date(t.createTime).toLocaleString() : "—",
                    },
                  })),
                },
              ],
            },
            ...triggers.map<SectionNode>((t) => ({
              kind: "section",
              children: [
                {
                  kind: "key-value-list",
                  items: [
                    { key: "Trigger", value: t.name },
                    { key: "Event type", value: t.eventType || "—" },
                  ],
                },
                {
                  kind: "action",
                  label: `Delete ${t.name}`,
                  variant: "danger",
                  action: {
                    type: "prompt-nosql-command",
                    command: "deleteTrigger",
                    title: `Delete trigger ${t.name}?`,
                    description:
                      "Removes the Eventarc trigger. Events from the configured source will no longer reach this service.",
                    fields: [
                      {
                        key: "triggerName",
                        label: "Trigger name",
                        kind: "text",
                        required: true,
                        defaultValue: t.name,
                        hidden: true,
                      },
                    ],
                    submitLabel: "Delete trigger",
                    danger: true,
                  },
                },
              ],
            })),
          ],
    headerActions: [{ kind: "action", label: "+ Create trigger", action: createTriggerAction }],
  };
}

export function gcpRenderDetail(
  ctx: GcpDetailContext,
  resource: ResourceInstance,
): DetailViewSchema {
  const fields = resource.fields;
  const statusVal = String(fields["status"] ?? fields["state"] ?? "");
  const subtitle = String(
    fields["region"] ?? fields["location"] ?? fields["zone"] ?? resource.resourceTypeId,
  );
  const base: DetailViewSchema = {
    title: resource.displayName,
    subtitle,
    status: {
      kind: "status-dot",
      status: gcpStatus(statusVal),
      ...(statusVal ? { label: statusVal } : {}),
    },
    sections: [
      {
        kind: "section",
        title: "Details",
        children: [
          {
            kind: "key-value-list",
            items: labeledFieldItems(fields, ctx.resourceTypes, resource.resourceTypeId),
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };

  if (resource.resourceTypeId === "gcs-bucket") {
    base.storageBrowser = { bucketName: resource.externalId ?? resource.displayName };
    delete base.status;
  }

  if (resource.resourceTypeId === "memorystore-redis") {
    // Memorystore is private-VPC only — we can't actively verify reachability
    // from outside the network, so surface it as informational rather than
    // healthy-green even when the provider reports READY.
    base.status = {
      kind: "status-dot",
      status: "info",
      ...(statusVal ? { label: statusVal } : {}),
    };
  }

  if (resource.resourceTypeId === "secret-manager-secret") {
    base.secretVersions = {
      supportsFileUpload: true,
      helpText:
        "Versions hold the actual secret material. Adding a version becomes the new 'latest' value; destroyed versions cannot be recovered.",
    };
    base.status = { kind: "status-dot", status: "healthy" };
  }

  if (resource.resourceTypeId === "kms-key") {
    base.secretVersions = {
      supportsReveal: false,
      valuelessAdd: true,
      helpText:
        "CryptoKey versions hold the actual key material, which never leaves Google Cloud. Adding a version rotates the key; destroy schedules deletion after a 24-hour grace period.",
    };
  }

  if (resource.resourceTypeId === "artifact-registry-repo") {
    const format = String(fields["format"] ?? "").toUpperCase();
    base.artifactRegistry = {
      format: format ? format.toLowerCase() : "generic",
      supportsTags: format === "DOCKER",
    };
    // Artifact Registry repos have no lifecycle "state" field — if the resource
    // exists in our DB, the repo is active.
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  }

  if (resource.resourceTypeId === "bigquery-dataset") {
    const datasetId = String(resource.fields["name"] ?? "");
    const friendlyName = String(fields["friendlyName"] ?? "");
    const location = String(fields["location"] ?? "");
    const description = String(fields["description"] ?? "");
    const labels = String(fields["labels"] ?? "");
    const defaultCollation = String(fields["defaultCollation"] ?? "");
    const defaultRoundingMode = String(fields["defaultRoundingMode"] ?? "");
    const storageBillingModel = String(fields["storageBillingModel"] ?? "");
    const maxTimeTravelHours = Number(fields["maxTimeTravelHours"] ?? 0);
    const defaultTableExpirationMs = Number(fields["defaultTableExpirationMs"] ?? 0);
    const defaultPartitionExpirationMs = Number(fields["defaultPartitionExpirationMs"] ?? 0);
    const isCaseInsensitive = Boolean(fields["isCaseInsensitive"]);
    const creationTime = String(fields["creationTime"] ?? "");
    const lastModifiedTime = String(fields["lastModifiedTime"] ?? "");

    base.subtitle = location ? `BigQuery · ${location}` : "BigQuery Dataset";
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };
    base.sections = [
      {
        kind: "section",
        title: "Dataset Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Dataset ID", value: datasetId, copyable: true },
              ...(friendlyName ? [{ key: "Friendly Name", value: friendlyName }] : []),
              ...(location ? [{ key: "Location", value: location }] : []),
              ...(description ? [{ key: "Description", value: description }] : []),
              ...(labels ? [{ key: "Labels", value: labels }] : []),
              ...(creationTime ? [{ key: "Created", value: creationTime }] : []),
              ...(lastModifiedTime ? [{ key: "Last modified", value: lastModifiedTime }] : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Default Settings",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(defaultTableExpirationMs > 0
                ? [
                    {
                      key: "Default table expiration",
                      value: `${defaultTableExpirationMs} ms`,
                    },
                  ]
                : [{ key: "Default table expiration", value: "Never" }]),
              ...(defaultPartitionExpirationMs > 0
                ? [
                    {
                      key: "Default partition expiration",
                      value: `${defaultPartitionExpirationMs} ms`,
                    },
                  ]
                : []),
              ...(defaultCollation ? [{ key: "Default collation", value: defaultCollation }] : []),
              ...(defaultRoundingMode
                ? [{ key: "Default rounding mode", value: defaultRoundingMode }]
                : []),
              { key: "Case insensitive", value: isCaseInsensitive ? "Yes" : "No" },
              ...(storageBillingModel
                ? [{ key: "Storage billing model", value: storageBillingModel }]
                : []),
              ...(maxTimeTravelHours > 0
                ? [{ key: "Max time travel", value: `${maxTimeTravelHours} hours` }]
                : []),
            ],
          },
        ],
      },
    ];

    const tablesJson = resource.resolvedOutputs["__tables__"] ?? "[]";
    const tables: SqlTableMeta[] = (() => {
      try {
        return JSON.parse(tablesJson) as SqlTableMeta[];
      } catch {
        return [];
      }
    })();
    base.sqlEditor = {
      connectionStringOutputKey: "__bigquery__",
      defaultQuery: `SELECT * FROM \`${datasetId}.INFORMATION_SCHEMA.TABLES\` LIMIT 20`,
      tables,
      supportsQueryCost: true,
    };
  }

  if (resource.resourceTypeId === "bigquery-table") {
    const tableId = String(fields["name"] ?? "");
    const friendlyName = String(fields["friendlyName"] ?? "");
    const type = String(fields["type"] ?? "TABLE");
    const location = String(fields["location"] ?? "");
    const description = String(fields["description"] ?? "");
    const labels = String(fields["labels"] ?? "");
    const creationTime = String(fields["creationTime"] ?? "");
    const lastModifiedTime = String(fields["lastModifiedTime"] ?? "");
    const expirationTime = String(fields["expirationTime"] ?? "NEVER");
    const primaryKeys = String(fields["primaryKeys"] ?? "");
    const partitioning = String(fields["partitioning"] ?? "");
    const clusteringFields = String(fields["clusteringFields"] ?? "");
    const defaultCollation = String(fields["defaultCollation"] ?? "");
    const defaultRoundingMode = String(fields["defaultRoundingMode"] ?? "");
    const caseInsensitive = Boolean(fields["caseInsensitive"]);

    base.subtitle = type ? `BigQuery ${type.toLowerCase()}` : "BigQuery Table";
    base.status = { kind: "status-dot", status: "healthy", label: type };
    base.sections = [
      {
        kind: "section",
        title: "Table Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Table ID", value: tableId, copyable: true },
              ...(friendlyName ? [{ key: "Friendly Name", value: friendlyName }] : []),
              { key: "Type", value: type },
              ...(location ? [{ key: "Data location", value: location }] : []),
              ...(creationTime ? [{ key: "Created", value: creationTime }] : []),
              ...(lastModifiedTime ? [{ key: "Last modified", value: lastModifiedTime }] : []),
              { key: "Table expiration", value: expirationTime },
              ...(description ? [{ key: "Description", value: description }] : []),
              ...(labels ? [{ key: "Labels", value: labels }] : []),
              ...(primaryKeys ? [{ key: "Primary key(s)", value: primaryKeys }] : []),
              ...(partitioning ? [{ key: "Partitioning", value: partitioning }] : []),
              ...(clusteringFields ? [{ key: "Clustering", value: clusteringFields }] : []),
              ...(defaultCollation ? [{ key: "Default collation", value: defaultCollation }] : []),
              ...(defaultRoundingMode
                ? [{ key: "Default rounding mode", value: defaultRoundingMode }]
                : []),
              ...(caseInsensitive !== undefined
                ? [{ key: "Case insensitive", value: caseInsensitive ? "Yes" : "No" }]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Storage Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Number of rows", value: String(fields["numRows"] ?? "0") },
              { key: "Total logical bytes", value: String(fields["numBytes"] ?? "0 B") },
              {
                key: "Active logical bytes",
                value: String(fields["numActiveLogicalBytes"] ?? "0 B"),
              },
              {
                key: "Long term logical bytes",
                value: String(fields["numLongTermLogicalBytes"] ?? "0 B"),
              },
              {
                key: "Current physical bytes",
                value: String(fields["numCurrentPhysicalBytes"] ?? "0 B"),
              },
              {
                key: "Total physical bytes",
                value: String(fields["numTotalPhysicalBytes"] ?? "0 B"),
              },
              {
                key: "Active physical bytes",
                value: String(fields["numActivePhysicalBytes"] ?? "0 B"),
              },
              {
                key: "Long term physical bytes",
                value: String(fields["numLongTermPhysicalBytes"] ?? "0 B"),
              },
              {
                key: "Time travel physical bytes",
                value: String(fields["numTimeTravelPhysicalBytes"] ?? "0 B"),
              },
            ],
          },
        ],
      },
    ];

    const schemaJson = String(fields["schemaJson"] ?? "");
    if (schemaJson) {
      const schemaRows = bigQuerySchemaToRows(schemaJson);
      if (schemaRows.length > 0) {
        base.sections.push({
          kind: "section",
          title: "Schema",
          children: [
            {
              kind: "table",
              emphasizeFirstColumn: true,
              columns: [
                { key: "name", label: "Field name", mono: true },
                { key: "type", label: "Type", width: "narrow" },
                { key: "mode", label: "Mode", width: "narrow" },
                { key: "description", label: "Description" },
              ],
              rows: schemaRows,
            },
          ],
        });
      } else {
        base.sections.push({
          kind: "section",
          title: "Schema",
          children: [{ kind: "text", content: schemaJson, variant: "mono" }],
        });
      }
    }
  }

  if (resource.resourceTypeId === "spanner-database") {
    const dialect = String(fields["dialect"] ?? "GOOGLE_STANDARD_SQL");
    const tablesJson = resource.resolvedOutputs["__tables__"] ?? "[]";
    const tables: SqlTableMeta[] = (() => {
      try {
        return JSON.parse(tablesJson) as SqlTableMeta[];
      } catch {
        return [];
      }
    })();
    const defaultQuery =
      dialect === "POSTGRESQL"
        ? "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20"
        : "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' LIMIT 20";
    base.sqlEditor = {
      connectionStringOutputKey: "__spanner__",
      defaultQuery,
      tables,
    };
  }

  if (resource.resourceTypeId === "cloud-dns-zone") {
    const dnsName = String(fields["dnsName"] ?? "");
    const nameservers = String(fields["nameservers"] ?? "");
    const nsList = nameservers.split(", ").filter(Boolean);
    const visibility = String(fields["visibility"] ?? "public");
    const dnssec = String(fields["dnssecState"] ?? "off");
    base.subtitle = `Cloud DNS \u00B7 ${visibility}`;
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };
    base.sections = [
      {
        kind: "section",
        title: "Zone Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "DNS Name", value: dnsName, copyable: true },
              { key: "Zone Name", value: String(fields["name"] ?? "") },
              { key: "Visibility", value: visibility },
              { key: "DNSSEC", value: dnssec },
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
            ],
          },
        ],
      },
      ...(nsList.length > 0
        ? [
            {
              kind: "section" as const,
              title: "Nameservers",
              children: [
                {
                  kind: "key-value-list" as const,
                  items: nsList.map((ns, i) => ({
                    key: `NS ${i + 1}`,
                    value: ns,
                    copyable: true,
                  })),
                },
                {
                  kind: "text" as const,
                  content:
                    "Point your domain registrar to these nameservers to use Google Cloud DNS.",
                  variant: "muted" as const,
                },
              ],
            },
          ]
        : []),
    ];
  }

  if (resource.resourceTypeId === "cloud-dns-record-set") {
    const type = String(fields["type"] ?? "");
    const name = String(fields["name"] ?? "");
    const rrdatas = String(fields["rrdatas"] ?? "");
    const ttl = Number(fields["ttl"] ?? 300);
    const zoneName = String(fields["zoneName"] ?? "");
    base.subtitle = `${type} → ${rrdatas.length > 50 ? `${rrdatas.slice(0, 47)}...` : rrdatas}`;
    base.status = { kind: "status-dot", status: "healthy" };
    base.sections = [
      {
        kind: "section",
        title: "Record Details",
        children: [
          { kind: "badge", label: type, color: dnsRecordBadgeColor(type) },
          {
            kind: "key-value-list",
            items: [
              { key: "Type", value: type },
              { key: "Name", value: name, copyable: true },
              { key: "Data", value: rrdatas, copyable: true },
              { key: "TTL", value: formatDnsTtl(ttl) },
              ...(zoneName ? [{ key: "Zone", value: zoneName }] : []),
            ],
          },
        ],
      },
    ];
  }

  // Pub/Sub topics and subscriptions have no lifecycle state in the GCP API —
  // if the resource exists, it's active. Give them a healthy dot so the UI
  // doesn't fall through to "unknown" grey.
  if (resource.resourceTypeId === "pubsub-topic") {
    base.subtitle = "Pub/Sub Topic";
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  }

  if (resource.resourceTypeId === "log-sink") {
    const disabled = fields["disabled"] === true;
    base.status = {
      kind: "status-dot",
      status: "info",
      ...(disabled ? { label: "Disabled" } : {}),
    };
  }

  if (resource.resourceTypeId === "cloud-tasks-queue") {
    const state = String(fields["state"] ?? "");
    base.subtitle = "Cloud Tasks Queue";
    base.status = {
      kind: "status-dot",
      status: state === "RUNNING" ? "healthy" : state === "PAUSED" ? "info" : gcpStatus(state),
      ...(state ? { label: state } : {}),
    };

    const formatRate = (n: unknown): string => {
      const v = Number(n);
      return Number.isFinite(v) && v > 0 ? `${v}/s` : "—";
    };
    const formatCount = (n: unknown): string => {
      const v = Number(n);
      return Number.isFinite(v) && v > 0 ? v.toLocaleString() : "—";
    };
    // Cloud Tasks API returns durations like "0.100s", "3600s", "0s" (Unlimited).
    const formatDuration = (raw: unknown): string => {
      const s = String(raw ?? "");
      if (!s) return "—";
      if (s === "0s") return "Unlimited";
      return s;
    };
    const formatMaxAttempts = (n: unknown): string => {
      const v = Number(n);
      // -1 (and the API's "unlimited" form) maps to Unlimited.
      if (!Number.isFinite(v) || v < 0) return "Unlimited";
      if (v === 0) return "—";
      return v.toLocaleString();
    };

    base.sections = [
      {
        kind: "section",
        title: "Configuration",
        children: [
          {
            kind: "key-value-list",
            items: [{ key: "Location", value: String(fields["region"] ?? "—") }],
          },
        ],
      },
      {
        kind: "section",
        title: "Rate limits",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Max rate", value: formatRate(fields["maxDispatchesPerSecond"]) },
              { key: "Max concurrent", value: formatCount(fields["maxConcurrentDispatches"]) },
              { key: "Max burst size", value: formatCount(fields["maxBurstSize"]) },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Retry parameters",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Max attempts", value: formatMaxAttempts(fields["maxAttempts"]) },
              { key: "Min interval", value: formatDuration(fields["minBackoff"]) },
              { key: "Max interval", value: formatDuration(fields["maxBackoff"]) },
              { key: "Max doublings", value: formatCount(fields["maxDoublings"]) },
              { key: "Max retry duration", value: formatDuration(fields["maxRetryDuration"]) },
            ],
          },
        ],
      },
    ];

    base.metricsCapability = { defaultTimeRangeMs: 3_600_000 };
    base.logs = { defaultTailLines: 200 };

    interface CloudTasksTaskRow {
      name: string;
      shortName: string;
      scheduleTime: string;
      createTime: string;
      dispatchCount: number;
      responseCount: number;
      url: string;
      method: string;
    }
    const tasksRaw = String(resource.resolvedOutputs["cloudTasksQueueTasks"] ?? "");
    let tasksData: { items: CloudTasksTaskRow[]; error?: string } = { items: [] };
    if (tasksRaw) {
      try {
        tasksData = JSON.parse(tasksRaw) as typeof tasksData;
      } catch {
        tasksData = { items: [] };
      }
    }
    const taskRows = tasksData.items.map((t) => ({
      cells: {
        name: t.shortName,
        method: t.method || "—",
        url: t.url || "—",
        scheduleTime: t.scheduleTime ? formatRelativeTime(t.scheduleTime) : "—",
        dispatchCount: String(t.dispatchCount ?? 0),
      },
    }));
    const tasksTab: import("@infrawrench/plugin-base").DetailViewTab = {
      id: "tasks",
      label: "Tasks",
      sections: [
        {
          kind: "section",
          title: tasksData.error
            ? "Tasks (failed to load)"
            : taskRows.length === 0
              ? "Tasks (queue is empty)"
              : `Tasks (showing ${taskRows.length})`,
          children: tasksData.error
            ? [{ kind: "text", content: tasksData.error }]
            : taskRows.length === 0
              ? [
                  {
                    kind: "text",
                    content:
                      "No pending tasks in this queue. Tasks appear here while they wait to be dispatched.",
                  },
                ]
              : [
                  {
                    kind: "table",
                    columns: [
                      { key: "name", label: "Task ID", mono: true, width: "wide" },
                      { key: "method", label: "Method", width: "narrow" },
                      { key: "url", label: "Target URL", mono: true, width: "wide" },
                      { key: "scheduleTime", label: "Scheduled" },
                      { key: "dispatchCount", label: "Dispatches", width: "narrow" },
                    ],
                    rows: taskRows,
                  },
                ],
        },
      ],
    };
    base.customTabs = [...(base.customTabs ?? []), tasksTab];
  }

  if (resource.resourceTypeId === "firestore-database") {
    const edition = String(fields["databaseEdition"] ?? "STANDARD");
    const type = String(fields["type"] ?? "FIRESTORE_NATIVE");
    const isMongoCompat = edition === "ENTERPRISE" && type === "FIRESTORE_NATIVE";
    base.subtitle =
      edition === "ENTERPRISE"
        ? "Firestore Enterprise"
        : type === "DATASTORE_MODE"
          ? "Firestore (Datastore mode)"
          : "Firestore Native";

    const parseJson = <T>(raw: unknown, fallback: T): T => {
      try {
        return JSON.parse(String(raw ?? "")) as T;
      } catch {
        return fallback;
      }
    };
    const collections = parseJson(resource.resolvedOutputs["firestoreCollections"], [] as string[]);
    const indexes = parseJson(
      resource.resolvedOutputs["firestoreIndexes"],
      [] as FirestoreIndexSummary[],
    );
    const schedules = parseJson(
      resource.resolvedOutputs["firestoreBackupSchedules"],
      [] as FirestoreBackupSchedule[],
    );
    const ttlConfigs = parseJson(
      resource.resolvedOutputs["firestoreTtl"],
      [] as FirestoreTtlConfig[],
    );
    const operations = parseJson(
      resource.resolvedOutputs["firestoreOperations"],
      [] as FirestoreOperation[],
    );
    const rulesInfo = parseJson(resource.resolvedOutputs["firestoreRules"], {
      rulesetName: "",
      content: "",
      updateTime: "",
      error: "",
    } as FirestoreRulesInfo);
    const backups = parseJson(
      resource.resolvedOutputs["firestoreBackups"],
      [] as FirestoreBackupInfo[],
    );
    const extras = parseJson(resource.resolvedOutputs["firestoreDatabaseExtras"], {
      earliestVersionTime: "",
      versionRetentionPeriod: "",
      pointInTimeRecoveryEnablement: "",
    } as FirestoreDatabaseExtras);
    const metrics = parseJson(resource.resolvedOutputs["firestoreUsageMetrics"], {
      reads24h: 0,
      writes24h: 0,
      deletes24h: 0,
      storageBytes: 0,
      available: false,
      error: "",
    } as FirestoreUsageMetrics);
    const iamInfo = parseJson(resource.resolvedOutputs["firestoreIam"], {
      bindings: [],
      etag: "",
      error: "",
    } as FirestoreIamInfo);
    const indexesError = String(resource.resolvedOutputs["firestoreIndexesError"] ?? "");

    // Inline document browser — MongoDB peer for Enterprise+MongoDB-compat
    // (host resolves a user-linked MongoDB account), otherwise native
    // Firestore REST.
    base.noSqlBrowser = {
      driver: isMongoCompat ? "mongodb-peer" : "firestore",
      databaseLabel: String(fields["name"] ?? resource.displayName),
      ...(isMongoCompat
        ? {
            helpText:
              "Enterprise databases with MongoDB compatibility speak the MongoDB wire protocol. Link a MongoDB account in your sidebar to browse this database inline.",
          }
        : {}),
    };

    // Render indexes and backup schedules as clickable pills in the
    // detail view's `children` grid. Each pill's `onClickAction` is a
    // `prompt-nosql-command` that deletes that specific resource — the
    // full name is pre-filled so the user only confirms the label.
    const indexPills: import("@infrawrench/plugin-base").DashboardCardSchema[] = indexes.map(
      (idx) => ({
        pluginId: "gcp",
        resourceTypeId: "firestore-index",
        // Not a real registered resource type — `onClickAction` replaces
        // the default navigate-to-resource behavior, so the id just needs
        // to be unique per pill.
        resourceId: idx.fullName,
        displayName: idx.fieldsDesc || idx.name,
        badges: [
          { kind: "badge", label: idx.collectionGroup || "—", color: "blue" },
          { kind: "badge", label: idx.state || "READY", color: "gray" },
        ],
        status: {
          kind: "status-dot",
          status:
            idx.state === "READY"
              ? "healthy"
              : idx.state === "CREATING"
                ? "provisioning"
                : idx.state === "NEEDS_REPAIR"
                  ? "error"
                  : "info",
          ...(idx.state ? { label: idx.state } : {}),
        },
        onClickAction: {
          type: "prompt-nosql-command",
          command: "deleteIndex",
          title: `Delete index on ${idx.collectionGroup}`,
          description: `${idx.fieldsDesc || idx.name} — queries that depended on this index will stop working.`,
          fields: [
            {
              key: "indexName",
              label: "Index resource name",
              kind: "text",
              required: true,
              defaultValue: idx.fullName,
              hidden: true,
            },
          ],
          submitLabel: "Delete index",
          danger: true,
        },
      }),
    );
    const schedulePills: import("@infrawrench/plugin-base").DashboardCardSchema[] = schedules.map(
      (s) => ({
        pluginId: "gcp",
        resourceTypeId: "firestore-backup-schedule",
        resourceId: s.fullName,
        displayName: s.name,
        badges: [
          { kind: "badge", label: s.recurrence, color: "blue" },
          ...(s.retention
            ? [{ kind: "badge" as const, label: s.retention, color: "gray" as const }]
            : []),
        ],
        status: { kind: "status-dot", status: "healthy", label: "Active" },
        onClickAction: {
          type: "prompt-nosql-command",
          command: "deleteBackupSchedule",
          title: `Delete schedule ${s.name}`,
          description: `${s.recurrence} backup schedule retained for ${s.retention || "an unspecified period"} — existing backups are unaffected.`,
          fields: [
            {
              key: "scheduleName",
              label: "Schedule resource name",
              kind: "text",
              required: true,
              defaultValue: s.fullName,
              hidden: true,
            },
          ],
          submitLabel: "Delete schedule",
          danger: true,
        },
      }),
    );

    const createIndexAction: import("@infrawrench/plugin-base").HostAction = {
      type: "prompt-nosql-command",
      command: "createIndex",
      title: "Create composite index",
      fields: [
        {
          key: "collection",
          label: "Collection",
          description:
            "Collection group to index. Firestore applies the index to every sub-collection with this id.",
          kind: "text",
          required: true,
          placeholder: "users",
        },
        {
          key: "fields",
          label: "Fields",
          description: "Add each field you want to index and pick an order.",
          kind: "key-value-list",
          required: true,
          entryKeyName: "fieldPath",
          entryValueName: "order",
          entryKeyLabel: "Field path",
          entryKeyPlaceholder: "email",
          entryValueLabel: "Order",
          entryValueOptions: [
            { id: "ASCENDING", label: "Asc" },
            { id: "DESCENDING", label: "Desc" },
            { id: "CONTAINS", label: "Array contains" },
          ],
          entryValueDefault: "ASCENDING",
          addLabel: "+ Add field",
          minEntries: 1,
        },
        {
          key: "queryScope",
          label: "Query scope",
          kind: "select",
          required: true,
          defaultValue: "COLLECTION",
          options: [
            { id: "COLLECTION", label: "Collection" },
            { id: "COLLECTION_GROUP", label: "Collection group" },
          ],
        },
      ],
      submitLabel: "Create index",
    };

    const createScheduleAction: import("@infrawrench/plugin-base").HostAction = {
      type: "prompt-nosql-command",
      command: "createBackupSchedule",
      title: "Create backup schedule",
      fields: [
        {
          key: "recurrence",
          label: "Recurrence",
          kind: "select",
          required: true,
          defaultValue: "daily",
          options: [
            { id: "daily", label: "Daily" },
            { id: "weekly", label: "Weekly" },
          ],
        },
        {
          key: "retentionSeconds",
          label: "Retention (seconds)",
          description: "How long each backup is kept. 604800 = 7 days; 3024000 = 35 days.",
          kind: "number",
          required: true,
          defaultValue: "604800",
          minValue: 3600,
          maxValue: 3024000,
          stepValue: 3600,
        },
        {
          key: "weekDay",
          label: "Day of week",
          kind: "select",
          required: true,
          defaultValue: "MONDAY",
          showWhen: { fieldKey: "recurrence", fieldValue: "weekly" },
          options: [
            { id: "MONDAY", label: "Monday" },
            { id: "TUESDAY", label: "Tuesday" },
            { id: "WEDNESDAY", label: "Wednesday" },
            { id: "THURSDAY", label: "Thursday" },
            { id: "FRIDAY", label: "Friday" },
            { id: "SATURDAY", label: "Saturday" },
            { id: "SUNDAY", label: "Sunday" },
          ],
        },
      ],
      submitLabel: "Create schedule",
    };

    const ttlPills: import("@infrawrench/plugin-base").DashboardCardSchema[] = ttlConfigs.map(
      (t) => ({
        pluginId: "gcp",
        resourceTypeId: "firestore-ttl-config",
        resourceId: t.fullName,
        displayName: `${t.collectionGroup}.${t.fieldPath}`,
        badges: [{ kind: "badge", label: t.state || "ACTIVE", color: "blue" }],
        status: {
          kind: "status-dot",
          status: t.state === "ACTIVE" ? "healthy" : "provisioning",
          ...(t.state ? { label: t.state } : {}),
        },
        onClickAction: {
          type: "prompt-nosql-command",
          command: "unsetTtl",
          title: `Remove TTL on ${t.collectionGroup}.${t.fieldPath}`,
          description:
            "Stop expiring documents based on this field. Existing documents are not deleted by this action.",
          fields: [
            {
              key: "fieldFullName",
              label: "Field resource name",
              kind: "text",
              required: true,
              defaultValue: t.fullName,
              hidden: true,
            },
          ],
          submitLabel: "Remove TTL",
          danger: true,
        },
      }),
    );

    const operationPills: import("@infrawrench/plugin-base").DashboardCardSchema[] = operations.map(
      (op) => ({
        pluginId: "gcp",
        resourceTypeId: "firestore-operation",
        resourceId: op.fullName,
        displayName: op.kind || op.id,
        badges: [{ kind: "badge", label: op.state || "—", color: "gray" }],
        status: {
          kind: "status-dot",
          status:
            op.error || op.state === "FAILED"
              ? "error"
              : op.state === "SUCCESSFUL" || op.state === "DONE"
                ? "healthy"
                : op.state === "CANCELLED"
                  ? "info"
                  : "provisioning",
          label: op.error ? "Error" : op.state || "Running",
        },
        // Operations have no detail page to navigate to — render as
        // read-only status chips.
        nonInteractive: true,
      }),
    );

    const firestoreCustomTabs: import("@infrawrench/plugin-base").DetailViewTab[] = [
      {
        id: "indexes",
        label: "Indexes",
        childGroups: [
          {
            title: "Composite indexes",
            items: indexPills,
            emptyText: indexesError
              ? `Failed to list indexes: ${indexesError}`
              : isMongoCompat
                ? "No Firestore-native composite indexes defined. MongoDB-style indexes on Enterprise DBs are managed via the MongoDB driver (Documents tab)."
                : "No composite indexes defined.",
            createLabel: "+ Create index",
            createAction: createIndexAction,
          },
        ],
      },
      {
        id: "disaster-recovery",
        label: "Disaster recovery",
        childGroups: [
          {
            title: "Backup schedules",
            items: schedulePills,
            emptyText: "No backup schedules configured.",
            createLabel: "+ Create schedule",
            createAction: createScheduleAction,
          },
          {
            title: "Completed backups",
            items: backups.map((b) => ({
              pluginId: "gcp",
              resourceTypeId: "firestore-backup",
              resourceId: b.fullName,
              displayName: b.name,
              badges: [
                { kind: "badge", label: b.state || "—", color: "blue" },
                ...(b.sizeBytes
                  ? [
                      {
                        kind: "badge" as const,
                        label: formatBackupSize(b.sizeBytes),
                        color: "gray" as const,
                      },
                    ]
                  : []),
              ],
              status: {
                kind: "status-dot",
                status: b.state === "READY" ? "healthy" : "provisioning",
                label: b.snapshotTime ? formatRelativeTime(b.snapshotTime) : b.state,
              },
            })),
            emptyText: "No backups yet. Completed backups from your schedules will appear here.",
          },
        ],
        sections: [
          {
            kind: "section",
            title: "Point-in-time recovery",
            children: [
              {
                kind: "key-value-list",
                items: [
                  {
                    key: "State",
                    value:
                      extras.pointInTimeRecoveryEnablement === "POINT_IN_TIME_RECOVERY_ENABLED"
                        ? "Enabled"
                        : "Disabled",
                  },
                  {
                    key: "Retention window",
                    value: formatPitrRetention(extras.versionRetentionPeriod),
                  },
                  {
                    key: "Earliest readable timestamp",
                    value: extras.earliestVersionTime || "—",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "ttl",
        label: "Time-to-live",
        childGroups: [
          {
            title: "TTL policies",
            items: ttlPills,
            emptyText: "No TTL policies configured. Add one to auto-delete documents by timestamp.",
            createLabel: "+ Set TTL",
            createAction: {
              type: "prompt-nosql-command",
              command: "setTtl",
              title: "Set TTL policy",
              description:
                "Documents in the chosen collection group whose field holds a past timestamp will be deleted within 24 hours.",
              fields: [
                {
                  key: "collectionGroup",
                  label: "Collection group",
                  kind: "text",
                  required: true,
                  placeholder: "sessions",
                },
                {
                  key: "fieldPath",
                  label: "Field name",
                  description:
                    "Name of a timestamp-typed field on your documents (e.g. expiresAt). Documents whose value at that field is in the past are deleted within 24 hours. Use dotted paths for nested fields.",
                  kind: "text",
                  required: true,
                  placeholder: "expiresAt",
                },
              ],
              submitLabel: "Set TTL",
            },
          },
        ],
      },
      {
        id: "operations",
        label: "Operations",
        headerActions: [
          {
            kind: "action",
            label: "Export",
            action: {
              type: "prompt-nosql-command",
              command: "exportDocuments",
              title: "Export database",
              description:
                "Write all documents (or selected collections) to a GCS bucket. The service account must have `roles/storage.objectAdmin` on the destination bucket.",
              fields: [
                {
                  key: "outputUri",
                  label: "GCS output prefix",
                  description:
                    "gs://bucket-name/some/path — an export folder will be created under it.",
                  kind: "text",
                  required: true,
                  placeholder: "gs://my-bucket/firestore-exports",
                },
                {
                  key: "collectionIds",
                  label: "Collections to export (comma-separated)",
                  description: "Leave blank to export every collection.",
                  kind: "text",
                  required: false,
                  placeholder: "users, orders",
                },
              ],
              submitLabel: "Start export",
            },
          },
          {
            kind: "action",
            label: "Import",
            action: {
              type: "prompt-nosql-command",
              command: "importDocuments",
              title: "Import database",
              description:
                "Import documents from a previous Firestore export. Existing documents with the same id are overwritten.",
              fields: [
                {
                  key: "inputUri",
                  label: "GCS input prefix",
                  kind: "text",
                  required: true,
                  placeholder: "gs://my-bucket/firestore-exports/2026-04-24T12:00:00Z",
                },
                {
                  key: "collectionIds",
                  label: "Collections to import (comma-separated)",
                  description: "Leave blank to import every collection in the export.",
                  kind: "text",
                  required: false,
                },
              ],
              submitLabel: "Start import",
            },
          },
        ],
        childGroups: [
          {
            title: "Recent operations",
            items: operationPills,
            emptyText: "No recent import or export operations.",
          },
        ],
      },
      {
        id: "usage",
        label: "Usage",
        sections: [
          {
            kind: "section",
            title: "Last 24 hours",
            children: metrics.available
              ? [
                  {
                    kind: "key-value-list",
                    items: [
                      { key: "Document reads", value: metrics.reads24h.toLocaleString() },
                      { key: "Document writes", value: metrics.writes24h.toLocaleString() },
                      { key: "Document deletes", value: metrics.deletes24h.toLocaleString() },
                      {
                        key: "Storage",
                        value: metrics.storageBytes
                          ? formatBackupSize(String(metrics.storageBytes))
                          : "—",
                      },
                    ],
                  },
                ]
              : [
                  {
                    kind: "text",
                    content: metrics.error || "Metrics unavailable.",
                    variant: "muted",
                  },
                  ...(isPermissionError(metrics.error)
                    ? [
                        {
                          kind: "text" as const,
                          content:
                            "Grant roles/monitoring.viewer to this service account to show live reads/writes/storage here.",
                          variant: "muted" as const,
                        },
                      ]
                    : []),
                ],
          },
          {
            kind: "section",
            title: "Resources",
            children: [
              {
                kind: "key-value-list",
                items: [
                  { key: "Collections", value: String(collections.length) },
                  { key: "Composite indexes", value: String(indexes.length) },
                  { key: "Backup schedules", value: String(schedules.length) },
                  { key: "Completed backups", value: String(backups.length) },
                  { key: "TTL policies", value: String(ttlConfigs.length) },
                  { key: "Recent operations", value: String(operations.length) },
                ],
              },
            ],
          },
        ],
      },
      (() => {
        const defaultRulesTemplate = `rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
  match /{document=**} {
    allow read, write: if false;
  }
}
}
`;
        const editRulesAction: import("@infrawrench/plugin-base").HostAction = {
          type: "prompt-nosql-command",
          command: "deployRules",
          title: rulesInfo.content ? "Edit security rules" : "Deploy security rules",
          description:
            "Compiles the source into a new ruleset and updates the release for this database. Takes effect in seconds.",
          fields: [
            {
              key: "source",
              label: "firestore.rules",
              description:
                "Firestore Security Rules source. See firebase.google.com/docs/rules/rules-language.",
              kind: "text",
              required: true,
              multiline: true,
              defaultValue: rulesInfo.content || defaultRulesTemplate,
            },
          ],
          submitLabel: "Deploy rules",
        };

        const rulesChildren: import("@infrawrench/plugin-base").SchemaNode[] =
          rulesInfo.error && !rulesInfo.content
            ? [
                { kind: "text", content: rulesInfo.error, variant: "muted" },
                ...(isPermissionError(rulesInfo.error)
                  ? [
                      {
                        kind: "text" as const,
                        content:
                          "Grant roles/firebaserules.viewer to this service account to show the deployed firestore.rules here.",
                        variant: "muted" as const,
                      },
                    ]
                  : []),
              ]
            : rulesInfo.content
              ? [
                  {
                    kind: "key-value-list",
                    items: [
                      ...(rulesInfo.updateTime
                        ? [
                            {
                              key: "Last deployed",
                              value: formatRelativeTime(rulesInfo.updateTime),
                            },
                          ]
                        : []),
                      ...(rulesInfo.rulesetName
                        ? [
                            {
                              key: "Ruleset",
                              value:
                                rulesInfo.rulesetName.split("/").pop() ?? rulesInfo.rulesetName,
                            },
                          ]
                        : []),
                    ],
                  },
                  { kind: "text", content: rulesInfo.content, variant: "mono" },
                ]
              : [
                  {
                    kind: "text",
                    content:
                      "No rules deployed to this database yet. Deploy rules to restrict access — without them, the database uses project-IAM-only access.",
                    variant: "muted",
                  },
                ];

        const grantRoleAction: import("@infrawrench/plugin-base").HostAction = {
          type: "prompt-nosql-command",
          command: "grantIamRole",
          title: "Grant Firestore role",
          description:
            "Adds a project IAM binding. Use the user:, serviceAccount:, or group: prefix for the principal.",
          fields: [
            {
              key: "role",
              label: "Role",
              kind: "select",
              required: true,
              options: [
                { id: "roles/datastore.user", label: "Datastore User (read/write)" },
                { id: "roles/datastore.viewer", label: "Datastore Viewer (read-only)" },
                { id: "roles/datastore.owner", label: "Datastore Owner (full access)" },
                { id: "roles/datastore.indexAdmin", label: "Datastore Index Admin" },
                {
                  id: "roles/datastore.importExportAdmin",
                  label: "Datastore Import/Export Admin",
                },
                {
                  id: "roles/datastore.keyVisualizerViewer",
                  label: "Datastore Key Visualizer Viewer",
                },
                { id: "roles/firebaserules.admin", label: "Firebase Rules Admin" },
                { id: "roles/firebaserules.viewer", label: "Firebase Rules Viewer" },
              ],
              defaultValue: "roles/datastore.user",
            },
            {
              key: "member",
              label: "Principal",
              description:
                "user:alice@example.com, serviceAccount:…@…iam.gserviceaccount.com, or group:ops@example.com",
              kind: "text",
              required: true,
              placeholder: "user:alice@example.com",
            },
          ],
          submitLabel: "Grant role",
        };

        const flatBindings = iamInfo.bindings.flatMap((b) =>
          b.members.map((m) => {
            const colon = m.indexOf(":");
            return {
              role: b.role,
              type: colon > 0 ? m.slice(0, colon) : "principal",
              principal: colon > 0 ? m.slice(colon + 1) : m,
              raw: m,
            };
          }),
        );

        const revokeAction: import("@infrawrench/plugin-base").HostAction = {
          type: "prompt-nosql-command",
          command: "revokeIamMember",
          title: "Revoke Firestore role",
          description:
            "Removes one principal from one role binding. The binding is deleted when the last member is removed.",
          fields: [
            {
              key: "binding",
              label: "Binding to revoke",
              kind: "select",
              required: true,
              options: flatBindings.map((fb) => ({
                id: `${fb.role}|${fb.raw}`,
                label: `${fb.role.replace(/^roles\//, "")} — ${fb.raw}`,
              })),
              defaultValue:
                flatBindings.length > 0 ? `${flatBindings[0]!.role}|${flatBindings[0]!.raw}` : "",
            },
          ],
          submitLabel: "Revoke",
          danger: true,
        };

        const iamChildren: import("@infrawrench/plugin-base").SchemaNode[] = iamInfo.error
          ? [
              { kind: "text", content: iamInfo.error, variant: "muted" },
              ...(isPermissionError(iamInfo.error)
                ? [
                    {
                      kind: "text" as const,
                      content:
                        "Grant roles/resourcemanager.projectIamAdmin (or roles/iam.securityReviewer for read-only) to list and manage IAM bindings.",
                      variant: "muted" as const,
                    },
                  ]
                : []),
            ]
          : flatBindings.length === 0
            ? [
                {
                  kind: "text",
                  content:
                    "No Firestore-related IAM bindings on this project. Grant a role to let principals access the database.",
                  variant: "muted",
                },
              ]
            : [
                {
                  kind: "text",
                  content:
                    "Firestore access is controlled by project-level IAM. Grant, revoke, or review role bindings below.",
                  variant: "muted",
                },
                {
                  kind: "table",
                  emphasizeFirstColumn: true,
                  columns: [
                    { key: "role", label: "Role" },
                    { key: "type", label: "Type", width: "narrow" },
                    { key: "principal", label: "Principal", mono: true },
                  ],
                  rows: flatBindings.map((fb) => ({
                    cells: {
                      role: fb.role.replace(/^roles\//, ""),
                      type: fb.type,
                      principal: fb.principal,
                    },
                  })),
                },
              ];

        const headerActions: import("@infrawrench/plugin-base").ActionNode[] = [
          {
            kind: "action",
            label: rulesInfo.content ? "Edit rules" : "Deploy rules",
            action: editRulesAction,
          },
          { kind: "action", label: "Grant role", action: grantRoleAction },
          ...(flatBindings.length > 0
            ? [
                {
                  kind: "action" as const,
                  label: "Revoke member",
                  variant: "danger" as const,
                  action: revokeAction,
                },
              ]
            : []),
        ];

        return {
          id: "security",
          label: "Security",
          headerActions,
          sections: [
            {
              kind: "section",
              title: "Active ruleset",
              children: rulesChildren,
            },
            {
              kind: "section",
              title: "IAM",
              children: iamChildren,
            },
          ],
        } as import("@infrawrench/plugin-base").DetailViewTab;
      })(),
    ];
    base.customTabs = [...(base.customTabs ?? []), ...firestoreCustomTabs];
  }

  if (resource.resourceTypeId === "cloud-run-service") {
    const f = resource.fields;
    const ro = resource.resolvedOutputs;
    const parseJson = <T>(key: string, fallback: T): T => {
      const raw = String(ro[key] ?? "");
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };
    const fullServiceResult = parseJson<CloudRunFullServiceResult>("cloudRunFullService", {
      service: null,
      error: "",
    });
    const cloudRunInput: CloudRunDetailInput = {
      fullService: fullServiceResult.service ?? {},
      fullServiceError: fullServiceResult.error,
      revisions: parseJson<CloudRunRevisionSummary[]>("cloudRunRevisions", []),
      triggers: parseJson<CloudRunTriggerSummary[]>("cloudRunTriggers", []),
      iam: parseJson<CloudRunIamInfo>("cloudRunIam", { bindings: [], etag: "", error: "" }),
      domainMappings: parseJson<CloudRunDomainMappingsResult>("cloudRunDomainMappings", {
        mappings: [],
        error: "",
      }),
      url: String(ro["url"] ?? ""),
      region: String(f["region"] ?? ""),
      name: String(f["name"] ?? ""),
      ingress: String(f["ingress"] ?? ""),
      lastModifier: String(f["lastModifier"] ?? ""),
      image: String(f["image"] ?? ""),
      serviceAccount: String(f["serviceAccount"] ?? ""),
      latestRevision: String(f["latestRevision"] ?? ""),
      deployClient: String(f["deployClient"] ?? ""),
      deployClientVersion: String(f["deployClientVersion"] ?? ""),
      sourceLocation: String(f["sourceLocation"] ?? ""),
    };

    base.subtitle = cloudRunInput.region;
    base.sections = [buildCloudRunServiceInfoSection(cloudRunInput)];
    base.metricsCapability = { defaultTimeRangeMs: 24 * 60 * 60 * 1000 };
    base.logs = { defaultTailLines: 200 };
    base.manifestEditor = { language: "yaml", readOnly: true, resourceKind: "Service" };
    base.customTabs = [
      ...(base.customTabs ?? []),
      buildCloudRunRevisionsTab(cloudRunInput),
      buildCloudRunNetworkingTab(cloudRunInput),
      buildCloudRunSecurityTab(cloudRunInput),
      buildCloudRunSourceTab(cloudRunInput),
      buildCloudRunTriggersTab(cloudRunInput),
    ];
  }

  if (resource.resourceTypeId === "cloud-function") {
    const f = resource.fields;
    const ro = resource.resolvedOutputs;
    const parseJson = <T>(key: string, fallback: T): T => {
      const raw = String(ro[key] ?? "");
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };
    const fullServiceResult = parseJson<CloudRunFullServiceResult>("cloudRunFullService", {
      service: null,
      error: "",
    });
    const cloudRunInput: CloudRunDetailInput = {
      fullService: fullServiceResult.service ?? {},
      fullServiceError: fullServiceResult.error,
      revisions: parseJson<CloudRunRevisionSummary[]>("cloudRunRevisions", []),
      triggers: parseJson<CloudRunTriggerSummary[]>("cloudRunTriggers", []),
      iam: parseJson<CloudRunIamInfo>("cloudRunIam", { bindings: [], etag: "", error: "" }),
      domainMappings: parseJson<CloudRunDomainMappingsResult>("cloudRunDomainMappings", {
        mappings: [],
        error: "",
      }),
      url: String(ro["url"] ?? ""),
      region: String(f["region"] ?? ""),
      name: String(f["name"] ?? ""),
      ingress: String(f["ingress"] ?? ""),
      lastModifier: String(f["lastModifier"] ?? ""),
      image: String(f["image"] ?? ""),
      serviceAccount: String(f["serviceAccount"] ?? ""),
      latestRevision: String(f["latestRevision"] ?? ""),
      deployClient: "",
      deployClientVersion: "",
      sourceLocation: String(f["sourceLocation"] ?? ""),
    };

    const runtime = String(f["runtime"] ?? "");
    const entryPoint = String(f["entryPoint"] ?? "");
    const environment = String(f["environment"] ?? "");
    const minInstances = String(f["minInstances"] ?? "");
    const maxInstances = String(f["maxInstances"] ?? "");
    const concurrency = String(f["concurrency"] ?? "");
    const availableMemory = String(f["availableMemory"] ?? "");
    const timeout = String(f["timeout"] ?? "");
    const stateMessage = String(f["stateMessage"] ?? "");
    const buildId = String(f["buildId"] ?? "");

    base.subtitle = cloudRunInput.region;

    const functionInfoItems: Array<{ key: string; value: string; copyable?: boolean }> = [];
    if (runtime) functionInfoItems.push({ key: "Runtime", value: runtime });
    if (entryPoint) functionInfoItems.push({ key: "Entry point", value: entryPoint });
    if (environment) functionInfoItems.push({ key: "Environment", value: environment });
    if (minInstances) functionInfoItems.push({ key: "Min instances", value: minInstances });
    if (maxInstances) functionInfoItems.push({ key: "Max instances", value: maxInstances });
    if (concurrency) functionInfoItems.push({ key: "Concurrency", value: concurrency });
    if (availableMemory) functionInfoItems.push({ key: "Memory", value: availableMemory });
    if (timeout) functionInfoItems.push({ key: "Timeout (s)", value: timeout });

    const functionInfoSection: SectionNode = {
      kind: "section",
      title: "Function info",
      children: [
        {
          kind: "key-value-list",
          items: functionInfoItems,
        },
      ],
    };

    const sections: SectionNode[] = [
      functionInfoSection,
      buildCloudRunServiceInfoSection(cloudRunInput),
    ];

    if (stateMessage) {
      sections.push({
        kind: "section",
        title: "State message",
        children: [
          {
            kind: "text",
            content: stateMessage,
            variant: "muted",
          },
        ],
      });
    }

    base.sections = sections;
    base.metricsCapability = { defaultTimeRangeMs: 24 * 60 * 60 * 1000 };
    base.logs = { defaultTailLines: 200 };
    base.manifestEditor = { language: "yaml", readOnly: true, resourceKind: "Service" };

    // Build a gen2-aware Source tab that combines the underlying Cloud Run
    // annotation-derived deployment info with Cloud Functions gen2 build info.
    const sourceTab = buildCloudRunSourceTab(cloudRunInput);
    const gen2SourceItems: Array<{ key: string; value: string; copyable?: boolean }> = [];
    if (runtime) gen2SourceItems.push({ key: "Runtime", value: runtime });
    if (entryPoint) gen2SourceItems.push({ key: "Entry point", value: entryPoint });
    if (cloudRunInput.sourceLocation)
      gen2SourceItems.push({
        key: "Source archive",
        value: cloudRunInput.sourceLocation,
        copyable: true,
      });
    if (buildId) gen2SourceItems.push({ key: "Build ID", value: buildId });
    if (gen2SourceItems.length > 0) {
      sourceTab.sections = [
        ...(sourceTab.sections ?? []),
        {
          kind: "section",
          title: "Function build",
          children: [
            {
              kind: "key-value-list",
              items: gen2SourceItems,
            },
          ],
        },
      ];
    }

    base.customTabs = [
      ...(base.customTabs ?? []),
      buildCloudRunRevisionsTab(cloudRunInput),
      buildCloudRunNetworkingTab(cloudRunInput),
      buildCloudRunSecurityTab(cloudRunInput),
      sourceTab,
      buildCloudRunTriggersTab(cloudRunInput),
    ];
  }

  if (resource.resourceTypeId === "instance-group") {
    base.subtitle = "Managed Instance Group";
    const rawMi = String(resource.resolvedOutputs["managedInstances"] ?? "");
    let managed: Array<{
      name: string;
      zone: string;
      resourceId: string;
      status: string;
      currentAction: string;
    }> = [];
    if (rawMi) {
      try {
        managed = JSON.parse(rawMi) as typeof managed;
      } catch {
        managed = [];
      }
    }
    if (managed.length > 0) {
      base.children = managed.map((m) => ({
        pluginId: "gcp",
        resourceTypeId: "gce-instance",
        resourceId: m.resourceId,
        displayName: m.name,
        status: {
          kind: "status-dot",
          status:
            m.currentAction && m.currentAction !== "NONE" ? "provisioning" : gcpStatus(m.status),
          ...(m.status || m.currentAction
            ? { label: m.currentAction !== "NONE" ? m.currentAction : m.status }
            : {}),
        },
        badges: [{ kind: "badge", label: m.zone, color: "gray" }],
      }));
    }
    base.headerActions = [
      {
        kind: "action",
        label: "Restart/replace VMs",
        action: {
          type: "plugin-action",
          actionId: "restart-replace",
          confirmMessage:
            "Restart/replace the VMs in this instance group? VMs will be restarted in place where possible, or replaced with new VMs from the current template if the change is disruptive.",
          successMessage: "Restart/replace requested.",
        },
      },
      ...(base.headerActions ?? []),
    ];
  }

  if (resource.resourceTypeId === "cloud-router") {
    base.subtitle = "Cloud Router";
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };

    interface RouterAdvertisedRange {
      range?: string;
      description?: string;
    }
    interface RouterBgp {
      asn?: number;
      advertiseMode?: string;
      advertisedGroups?: string[];
      advertisedIpRanges?: RouterAdvertisedRange[];
    }
    interface RouterBgpPeer {
      name?: string;
      interfaceName?: string;
      importPolicies?: string[];
      exportPolicies?: string[];
    }
    interface RouterNat {
      name?: string;
    }
    interface RouterFull {
      bgp?: RouterBgp;
      bgpPeers?: RouterBgpPeer[];
      nats?: RouterNat[];
      error?: string;
    }
    interface RoutePolicy {
      name?: string;
      type?: string;
      terms?: unknown[];
    }
    interface RoutePoliciesResult {
      result?: RoutePolicy[];
      error?: string;
    }

    const parseJson = <T>(raw: unknown, fallback: T): T => {
      const s = String(raw ?? "");
      if (!s) return fallback;
      try {
        return JSON.parse(s) as T;
      } catch {
        return fallback;
      }
    };

    const full = parseJson<RouterFull>(resource.resolvedOutputs["cloudRouterFull"], {});
    const policiesData = parseJson<RoutePoliciesResult>(
      resource.resolvedOutputs["cloudRouterPolicies"],
      { result: [] },
    );

    const advertiseMode = String(full.bgp?.advertiseMode ?? "DEFAULT");
    const advertisedGroups = full.bgp?.advertisedGroups ?? [];
    const advertisedRanges = full.bgp?.advertisedIpRanges ?? [];
    // DEFAULT mode advertises all subnets. CUSTOM mode only advertises what's
    // listed — explicit "ALL_SUBNETS" in advertisedGroups means yes too.
    const advertisesAllSubnets =
      advertiseMode === "DEFAULT" || advertisedGroups.includes("ALL_SUBNETS");

    const advertisedRangeRows = advertisedRanges
      .filter((r) => typeof r.range === "string" && r.range.length > 0)
      .map((r) => ({
        cells: { range: String(r.range), description: String(r.description ?? "") },
      }));

    const peers = full.bgpPeers ?? [];
    const sessionsForPolicy = (policyName: string): string => {
      const count = peers.filter(
        (p) =>
          (p.importPolicies ?? []).includes(policyName) ||
          (p.exportPolicies ?? []).includes(policyName),
      ).length;
      return count > 0 ? String(count) : "—";
    };
    const policies = policiesData.result ?? [];
    const policyTypeLabel = (raw: string): string => {
      if (raw === "ROUTE_POLICY_TYPE_IMPORT") return "Import";
      if (raw === "ROUTE_POLICY_TYPE_EXPORT") return "Export";
      return raw || "—";
    };

    const nats = full.nats ?? [];
    const natRows = nats
      .filter((n) => typeof n.name === "string" && n.name.length > 0)
      .map((n) => ({ cells: { name: String(n.name), status: "Active" } }));

    const bgpDetailItems = [
      { key: "BGP ASN", value: full.bgp?.asn ? String(full.bgp.asn) : "—" },
      { key: "Advertise mode", value: advertiseMode },
      { key: "Advertise all available subnets", value: advertisesAllSubnets ? "Yes" : "No" },
    ];

    const advertisementsSection: import("@infrawrench/plugin-base").SectionNode = {
      kind: "section",
      title: "BGP advertisements",
      children: [{ kind: "key-value-list", items: bgpDetailItems }],
    };
    if (advertisedRangeRows.length > 0) {
      advertisementsSection.children.push({
        kind: "table",
        columns: [
          { key: "range", label: "Custom IP range", mono: true, width: "narrow" },
          { key: "description", label: "Description" },
        ],
        rows: advertisedRangeRows,
      });
    } else {
      advertisementsSection.children.push({
        kind: "text",
        content: "This router does not advertise any custom IP ranges.",
      });
    }

    const policiesSection: import("@infrawrench/plugin-base").SectionNode = {
      kind: "section",
      title: "BGP route policies",
      children: [],
    };
    if (policiesData.error) {
      policiesSection.children.push({
        kind: "text",
        content: `Could not load route policies: ${policiesData.error}`,
      });
    } else if (policies.length === 0) {
      policiesSection.children.push({ kind: "text", content: "No BGP route policies." });
    } else {
      policiesSection.children.push({
        kind: "table",
        columns: [
          { key: "name", label: "Name", mono: true },
          { key: "type", label: "Type", width: "narrow" },
          { key: "termCount", label: "Term count", width: "narrow" },
          { key: "bgpSessions", label: "BGP sessions", width: "narrow" },
        ],
        rows: policies.map((p) => ({
          cells: {
            name: String(p.name ?? ""),
            type: policyTypeLabel(String(p.type ?? "")),
            termCount: String((p.terms ?? []).length),
            bgpSessions: sessionsForPolicy(String(p.name ?? "")),
          },
        })),
      });
    }

    const natSection: import("@infrawrench/plugin-base").SectionNode = {
      kind: "section",
      title: "Cloud NAT gateways",
      children: [],
    };
    if (natRows.length === 0) {
      natSection.children.push({ kind: "text", content: "No Cloud NAT gateways." });
    } else {
      natSection.children.push({
        kind: "table",
        columns: [
          { key: "name", label: "Gateway name", mono: true },
          { key: "status", label: "Status", width: "narrow" },
        ],
        rows: natRows,
      });
    }

    base.sections = [...base.sections, advertisementsSection, policiesSection, natSection];

    if (full.error) {
      base.sections.push({
        kind: "section",
        title: "Router details",
        children: [{ kind: "text", content: `Could not load router details: ${full.error}` }],
      });
    }
  }

  if (resource.resourceTypeId === "cloud-nat") {
    base.subtitle = "Cloud NAT";
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };
    base.metricsCapability = { defaultTimeRangeMs: 3_600_000 };

    interface NatLogConfig {
      enable?: boolean;
      filter?: string;
    }
    interface NatConfig {
      name?: string;
      natIpAllocateOption?: string;
      natIps?: string[];
      sourceSubnetworkIpRangesToNat?: string;
      enableDynamicPortAllocation?: boolean;
      minPortsPerVm?: number;
      maxPortsPerVm?: number;
      enableEndpointIndependentMapping?: boolean;
      udpIdleTimeoutSec?: number;
      tcpEstablishedIdleTimeoutSec?: number;
      tcpTransitoryIdleTimeoutSec?: number;
      tcpTimeWaitTimeoutSec?: number;
      icmpIdleTimeoutSec?: number;
      logConfig?: NatLogConfig;
    }
    interface RouterDoc {
      nats?: NatConfig[];
      error?: string;
    }
    interface NatStatus {
      name?: string;
      autoAllocatedNatIps?: string[];
      userAllocatedNatIps?: string[];
      numVmEndpointsWithNatMappings?: number;
      minExtraNatIpsNeeded?: number;
    }
    interface RouterStatusDoc {
      result?: { natStatus?: NatStatus[] };
      error?: string;
    }

    const parseJson = <T>(raw: unknown, fallback: T): T => {
      const s = String(raw ?? "");
      if (!s) return fallback;
      try {
        return JSON.parse(s) as T;
      } catch {
        return fallback;
      }
    };

    const router = parseJson<RouterDoc>(resource.resolvedOutputs["cloudNatRouter"], {});
    const status = parseJson<RouterStatusDoc>(resource.resolvedOutputs["cloudNatStatus"], {});
    const natName = String(resource.fields["name"] ?? "");
    const natConfig = (router.nats ?? []).find((n) => n.name === natName) ?? {};
    const natStatus = (status.result?.natStatus ?? []).find((n) => n.name === natName) ?? {};

    const allocationOption = String(
      natConfig.natIpAllocateOption ?? resource.fields["natIpAllocateOption"] ?? "AUTO_ONLY",
    );
    const autoIps = natStatus.autoAllocatedNatIps ?? [];
    const userIps = natStatus.userAllocatedNatIps ?? [];
    const allocatedIps = [...autoIps, ...userIps];
    const ipv4Count = allocatedIps.length;
    const minExtraNeeded = Number(natStatus.minExtraNatIpsNeeded ?? 0);

    const allocatedSection: import("@infrawrench/plugin-base").SectionNode = {
      kind: "section",
      title: "Allocated external IP addresses",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Allocated external IPv4 addresses", value: String(ipv4Count) },
            {
              key: "IP allocation",
              value: allocationOption === "AUTO_ONLY" ? "Automatic" : "Manual",
            },
            {
              key: "VM endpoints with NAT mappings",
              value: String(natStatus.numVmEndpointsWithNatMappings ?? 0),
            },
            ...(minExtraNeeded > 0
              ? [{ key: "Min extra NAT IPs needed", value: String(minExtraNeeded) }]
              : []),
          ],
        },
      ],
    };
    if (allocatedIps.length > 0) {
      allocatedSection.children.push({
        kind: "table",
        columns: [
          { key: "address", label: "External IPv4 address", mono: true },
          { key: "type", label: "Type", width: "narrow" },
        ],
        rows: [
          ...autoIps.map((ip) => ({ cells: { address: ip, type: "Auto" } })),
          ...userIps.map((ip) => ({ cells: { address: ip, type: "Manual" } })),
        ],
      });
    }

    const dynamic = natConfig.enableDynamicPortAllocation === true;
    const eim = natConfig.enableEndpointIndependentMapping === true;
    const minPorts = natConfig.minPortsPerVm ?? 64;
    const maxPorts = natConfig.maxPortsPerVm;

    const portAllocationItems = [
      { key: "Dynamic port allocation", value: dynamic ? "Enabled" : "Disabled" },
      { key: "Minimum ports per VM instance", value: String(minPorts) },
      ...(dynamic && typeof maxPorts === "number"
        ? [{ key: "Maximum ports per VM instance", value: String(maxPorts) }]
        : []),
      { key: "Endpoint-Independent Mapping", value: eim ? "Enabled" : "Disabled" },
    ];

    const timeoutItems = [
      { key: "UDP", value: `${natConfig.udpIdleTimeoutSec ?? 30} seconds` },
      {
        key: "TCP established",
        value: `${natConfig.tcpEstablishedIdleTimeoutSec ?? 1200} seconds`,
      },
      {
        key: "TCP transitory",
        value: `${natConfig.tcpTransitoryIdleTimeoutSec ?? 30} seconds`,
      },
      { key: "ICMP", value: `${natConfig.icmpIdleTimeoutSec ?? 30} seconds` },
      {
        key: "TCP time wait",
        value: `${natConfig.tcpTimeWaitTimeoutSec ?? 120} seconds`,
      },
    ];

    const portAllocationSection: import("@infrawrench/plugin-base").SectionNode = {
      kind: "section",
      title: "Port allocation",
      children: [{ kind: "key-value-list", items: portAllocationItems }],
    };

    const timeoutSection: import("@infrawrench/plugin-base").SectionNode = {
      kind: "section",
      title: "Timeout for protocol connections",
      children: [{ kind: "key-value-list", items: timeoutItems }],
    };

    const logEnable = natConfig.logConfig?.enable === true;
    const logFilter = String(natConfig.logConfig?.filter ?? "");
    const logFilterLabel =
      logFilter === "ALL"
        ? "Translations and errors"
        : logFilter === "TRANSLATIONS_ONLY"
          ? "Translations only"
          : logFilter === "ERRORS_ONLY"
            ? "Errors only"
            : logFilter || "—";
    const loggingSection: import("@infrawrench/plugin-base").SectionNode = {
      kind: "section",
      title: "Logging",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Logging", value: logEnable ? "Enabled" : "No logging" },
            ...(logEnable ? [{ key: "Filter", value: logFilterLabel }] : []),
          ],
        },
      ],
    };

    base.sections = [
      ...base.sections,
      allocatedSection,
      portAllocationSection,
      timeoutSection,
      loggingSection,
    ];

    if (router.error) {
      base.sections.push({
        kind: "section",
        title: "Router config",
        children: [{ kind: "text", content: `Could not load router config: ${router.error}` }],
      });
    }
    if (status.error) {
      base.sections.push({
        kind: "section",
        title: "Router status",
        children: [{ kind: "text", content: `Could not load router status: ${status.error}` }],
      });
    }
  }

  if (resource.resourceTypeId === "cloud-armor-policy") {
    base.subtitle = "Cloud Armor security policy";
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };
    base.logs = { defaultTailLines: 200 };

    interface ArmorRule {
      priority: number;
      description: string;
      action: string;
      preview: boolean;
      mode: "basic" | "advanced";
      match: string;
      responseCode: string;
    }
    interface ArmorPolicyFull {
      rules?: ArmorRule[];
      fingerprint?: string;
      error?: string;
    }
    interface ArmorTarget {
      name: string;
      region: string;
    }
    interface ArmorTargets {
      targets?: ArmorTarget[];
      error?: string;
    }

    const parseJson = <T>(raw: unknown, fallback: T): T => {
      const s = String(raw ?? "");
      if (!s) return fallback;
      try {
        return JSON.parse(s) as T;
      } catch {
        return fallback;
      }
    };
    const policyData = parseJson<ArmorPolicyFull>(
      resource.resolvedOutputs["cloudArmorPolicyFull"],
      {},
    );
    const targetsData = parseJson<ArmorTargets>(resource.resolvedOutputs["cloudArmorTargets"], {});
    const rules = policyData.rules ?? [];
    const targets = targetsData.targets ?? [];

    const actionLabel = (action: string): string => {
      if (action === "allow") return "Allow";
      const m = /^deny\((\d+)\)$/.exec(action);
      if (m) return `Deny (${m[1]})`;
      return action || "—";
    };

    const addRuleAction: HostAction = {
      type: "prompt-nosql-command",
      command: "addRule",
      title: "Add rule",
      description:
        "Rules tell your security policy what to do. When the condition is met, the action will occur.",
      fields: [
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
          multiline: true,
        },
        {
          key: "mode",
          label: "Mode",
          kind: "select",
          required: true,
          defaultValue: "basic",
          options: [
            { id: "basic", label: "Basic mode (IP addresses/ranges only)" },
            { id: "advanced", label: "Advanced mode" },
          ],
        },
        {
          key: "match",
          label: "Match",
          kind: "text",
          required: true,
          multiline: true,
          placeholder: "1.1.1.0/24, 1.2.0.0",
          description:
            "Up to 10 IP addresses or ranges, comma-separated. Use * to match all IPs. Advanced mode accepts a CEL expression.",
        },
        {
          key: "action",
          label: "Action",
          kind: "select",
          required: true,
          defaultValue: "deny",
          options: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
        },
        {
          key: "responseCode",
          label: "Response code",
          kind: "select",
          required: false,
          defaultValue: "403",
          showWhen: { fieldKey: "action", fieldValue: "deny" },
          options: [
            { id: "403", label: "403 (Forbidden)" },
            { id: "404", label: "404 (Not Found)" },
            { id: "502", label: "502 (Bad Gateway)" },
          ],
        },
        {
          key: "preview",
          label: "Enable preview only",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "false", label: "Off" },
            { id: "true", label: "On — log but don't enforce" },
          ],
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: true,
          defaultValue: "1000",
          minValue: 0,
          maxValue: 2147483647,
          description: "Priority is evaluated from 0 (highest) to 2,147,483,647 (lowest).",
        },
      ],
      submitLabel: "Add",
    };

    const rulesSection: SectionNode = {
      kind: "section",
      title: "Rules",
      children: [],
    };
    if (policyData.error) {
      rulesSection.children.push({
        kind: "text",
        content: `Could not load rules: ${policyData.error}`,
        variant: "muted",
      });
    } else if (rules.length === 0) {
      rulesSection.children.push({
        kind: "text",
        content: "No rules defined yet.",
        variant: "muted",
      });
    } else {
      rulesSection.children.push({
        kind: "table",
        columns: [
          { key: "priority", label: "Priority", width: "narrow" },
          { key: "description", label: "Description" },
          { key: "mode", label: "Mode", width: "narrow" },
          { key: "match", label: "Match", mono: true, width: "wide" },
          { key: "action", label: "Action", width: "narrow" },
          { key: "preview", label: "Preview", width: "narrow" },
          { key: "delete", label: "", width: "narrow" },
        ],
        rows: rules.map((r) => ({
          cells: {
            priority: String(r.priority),
            description: r.description || "—",
            mode: r.mode === "basic" ? "Basic" : "Advanced",
            match: r.match || "—",
            action: actionLabel(r.action),
            preview: r.preview ? "Yes" : "—",
            delete: {
              kind: "action",
              label: "Delete",
              variant: "ghost",
              action: {
                type: "prompt-nosql-command",
                command: "deleteRule",
                title: `Delete rule with priority ${r.priority}?`,
                description: r.description
                  ? `"${r.description}" will be removed from the policy.`
                  : "This rule will be removed from the policy.",
                fields: [
                  {
                    key: "priority",
                    label: "Priority",
                    kind: "number",
                    required: true,
                    defaultValue: String(r.priority),
                    hidden: true,
                  },
                ],
                submitLabel: "Delete",
                danger: true,
              },
            },
          },
        })),
      });
    }
    rulesSection.children.push({ kind: "action", label: "Add rule", action: addRuleAction });

    const addTargetAction: HostAction = {
      type: "prompt-nosql-command",
      command: "addTarget",
      title: "Apply policy to new target",
      description:
        "Targets are Google Cloud resources that you want to control access to. Use external load balancer backend services as targets.",
      fields: [
        {
          key: "backendService",
          label: "Backend service",
          kind: "resource-picker",
          required: true,
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "backend-service", outputKey: "name" },
          ],
        },
      ],
      submitLabel: "Add",
    };

    const targetsSection: SectionNode = {
      kind: "section",
      title: "Targets",
      children: [],
    };
    if (targetsData.error) {
      targetsSection.children.push({
        kind: "text",
        content: `Could not load targets: ${targetsData.error}`,
        variant: "muted",
      });
    } else if (targets.length === 0) {
      targetsSection.children.push({
        kind: "text",
        content: "No backend services use this policy yet.",
        variant: "muted",
      });
    } else {
      targetsSection.children.push({
        kind: "table",
        columns: [
          { key: "name", label: "Backend service", mono: true },
          { key: "region", label: "Region", width: "narrow" },
          { key: "remove", label: "", width: "narrow" },
        ],
        rows: targets.map((t) => ({
          cells: {
            name: t.name,
            region: t.region || "global",
            remove: {
              kind: "action",
              label: "Detach",
              variant: "ghost",
              action: {
                type: "prompt-nosql-command",
                command: "removeTarget",
                title: `Detach ${t.name} from this policy?`,
                description: "The backend service will no longer be protected by this policy.",
                fields: [
                  {
                    key: "backendService",
                    label: "Backend service",
                    kind: "text",
                    required: true,
                    defaultValue: t.name,
                    hidden: true,
                  },
                  {
                    key: "region",
                    label: "Region",
                    kind: "text",
                    required: false,
                    defaultValue: t.region,
                    hidden: true,
                  },
                ],
                submitLabel: "Detach",
                danger: true,
              },
            },
          },
        })),
      });
    }
    targetsSection.children.push({ kind: "action", label: "Add target", action: addTargetAction });

    base.sections = [...base.sections, rulesSection, targetsSection];
  }

  if (resource.resourceTypeId === "pubsub-subscription") {
    base.subtitle = "Pub/Sub Subscription";
    base.status = { kind: "status-dot", status: "healthy", label: "Active" };
    // Link back to the source topic. parentResourceId is set by the lister
    // when the topic is in the same project; otherwise reconstruct from the
    // short topic field under the current project.
    const topicResourceId =
      resource.parentResourceId ??
      (fields["topic"]
        ? ctx.id(
            resource.accountId,
            "pubsub-topic",
            `projects/${ctx.project}/topics/${String(fields["topic"])}`,
          )
        : "");
    if (topicResourceId) {
      base.headerActions = [
        {
          kind: "action",
          label: `View topic: ${String(fields["topic"] ?? "")}`,
          action: {
            type: "navigate-to-resource",
            pluginId: "gcp",
            resourceTypeId: "pubsub-topic",
            resourceId: topicResourceId,
          },
        },
        ...(base.headerActions ?? []),
      ];
    }
  }

  return base;
}
