/**
 * Detail renderers for Cloud Run services and Cloud Functions (gen2).
 *
 * Cloud Functions (gen2) services are backed by Cloud Run and reuse the same
 * Service info / Revisions / Networking / Security / Source / Triggers tabs;
 * the gen2 renderer just adds a "Function info" section and decorates the
 * Source tab with the function build metadata.
 */
import type {
  DetailViewSchema,
  DetailViewTab,
  ResourceInstance,
  SectionNode,
  SchemaNode,
  HostAction,
  TextNode,
  KeyValueListNode,
  TableNode,
  ActionNode,
} from "@infrawrench/plugin-base";
import type {
  CloudRunRevisionSummary,
  CloudRunIamInfo,
  CloudRunTriggerSummary,
  CloudRunFullServiceResult,
  CloudRunDomainMappingsResult,
} from "./cloud-run-handlers.js";
import { isPermissionError, shortImage } from "./shared-renderers.js";

/**
 * Bundled inputs needed to render Cloud Run-style detail views (Service info,
 * Revisions, Networking, Security, Source, Triggers tabs). Cloud Functions
 * (gen2) services are backed by Cloud Run and can reuse the same helpers by
 * parsing their own resolvedOutputs into this shape.
 */
interface CloudRunDetailInput {
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

/**
 * Parse Cloud Run-shaped resolvedOutputs into a CloudRunDetailInput. Shared
 * between the cloud-run-service and cloud-function (gen2) renderers.
 */
function parseCloudRunInput(
  resource: ResourceInstance,
  overrides: Partial<CloudRunDetailInput> = {},
): CloudRunDetailInput {
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
  return {
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
    ...overrides,
  };
}

/** Apply the Cloud Run service renderer to `base`. */
export function renderCloudRunService(resource: ResourceInstance, base: DetailViewSchema): void {
  const cloudRunInput = parseCloudRunInput(resource);

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

/** Apply the Cloud Function (gen2) renderer to `base`. */
export function renderCloudFunction(resource: ResourceInstance, base: DetailViewSchema): void {
  const f = resource.fields;
  // Gen2 functions are deployed by the Cloud Functions API, not directly by
  // the user. deployClient/deployClientVersion are stripped to avoid showing
  // the internal "cloud-functions" deployer.
  const cloudRunInput = parseCloudRunInput(resource, {
    deployClient: "",
    deployClientVersion: "",
  });

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
