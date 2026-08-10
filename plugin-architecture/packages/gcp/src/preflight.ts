/**
 * Credential preflight + least-privilege custom-role template for GCP.
 *
 * Probe strategy: one call to Cloud Resource Manager v3
 * `projects/{project}:testIamPermissions` with every declared permission —
 * the response is exactly the granted subset, so the checklist is precise
 * without touching any real resource API. (Verified 2026: POST
 * https://cloudresourcemanager.googleapis.com/v3/projects/{id}:testIamPermissions,
 * body `{"permissions": [...]}` → `{"permissions": [...granted]}`; wildcards
 * are not allowed; no documented per-call cap, chunked at 100 defensively.)
 *
 * Cost reporting additionally needs the Cloud Billing BigQuery export to be
 * configured on the account (`billingExportTable` credential field) — a
 * missing table is reported as a `missing` check with setup guidance, the
 * same signal `fetchCostData` raises as a `CostSetupError` later.
 */
import type {
  PolicyTemplate,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";
import { fetchAccessToken, type ServiceAccountKey } from "./auth.js";

const RESOURCES_PERMISSIONS: PreflightPermission[] = [
  { id: "compute.instances.list", label: "List Compute Engine instances" },
  { id: "storage.buckets.list", label: "List Cloud Storage buckets" },
  { id: "container.clusters.list", label: "List GKE clusters" },
  { id: "cloudsql.instances.list", label: "List Cloud SQL instances" },
  { id: "run.services.list", label: "List Cloud Run services" },
  { id: "pubsub.topics.list", label: "List Pub/Sub topics" },
  { id: "bigquery.datasets.get", label: "List BigQuery datasets" },
  { id: "secretmanager.secrets.list", label: "List Secret Manager secrets" },
];

const METRICS_PERMISSIONS: PreflightPermission[] = [
  { id: "monitoring.timeSeries.list", label: "Read Cloud Monitoring time series" },
];

const COSTS_PERMISSIONS: PreflightPermission[] = [
  { id: "bigquery.jobs.create", label: "Run BigQuery queries (billing export)" },
  { id: "bigquery.tables.getData", label: "Read the billing export table" },
];

export const gcpPreflight: PreflightDeclaration = {
  capabilities: [
    {
      id: "resources",
      label: "Resource inventory",
      description:
        "Read access across Compute, GKE, Cloud SQL, Cloud Run, Storage and the other services the plugin lists. Checked via a representative sample.",
      requiredPermissions: RESOURCES_PERMISSIONS,
      essential: true,
    },
    {
      id: "metrics",
      label: "Metrics & dashboards",
      description: "Cloud Monitoring time series for resource dashboards.",
      requiredPermissions: METRICS_PERMISSIONS,
    },
    {
      id: "costs",
      label: "Cost reporting",
      description:
        "Daily spend read from the Cloud Billing BigQuery export — needs the export configured plus BigQuery access.",
      requiredPermissions: COSTS_PERMISSIONS,
    },
  ],
  templateFormat: { label: "GCP custom role (YAML)", language: "yaml" },
};

const IAM_HELP_LINK = {
  label: "Open IAM roles in the Cloud console",
  url: "https://console.cloud.google.com/iam-admin/roles",
};

const BILLING_EXPORT_HELP_LINK = {
  label: "Set up Cloud Billing export to BigQuery",
  url: "https://cloud.google.com/billing/docs/how-to/export-data-bigquery",
};

/**
 * Permissions granted per capability in the generated custom role. Broader
 * than the probed sample for `resources` — it must cover every lister the
 * plugin ships. GCP custom roles don't accept wildcards, so the list is
 * spelled out.
 */
const TEMPLATE_PERMISSIONS: Record<string, string[]> = {
  resources: [
    "aiplatform.endpoints.list",
    "alloydb.clusters.list",
    "alloydb.instances.list",
    "appengine.services.list",
    "artifactregistry.repositories.list",
    "bigquery.datasets.get",
    "bigquery.tables.list",
    "bigtable.instances.list",
    // ListBuildTriggers checks cloudbuild.builds.list — there is no separate
    // triggers.list permission.
    "cloudbuild.builds.list",
    "clouddeploy.deliveryPipelines.list",
    "cloudfunctions.functions.list",
    "cloudkms.cryptoKeys.list",
    "cloudkms.keyRings.list",
    // The KMS lister fans out via ListLocations, which checks this.
    "cloudkms.locations.list",
    // Scheduler/Tasks listers also fan out via their ListLocations calls.
    "cloudscheduler.jobs.list",
    "cloudscheduler.locations.list",
    "cloudsql.instances.list",
    "cloudtasks.locations.list",
    "cloudtasks.queues.list",
    "composer.environments.list",
    "compute.addresses.list",
    "compute.backendServices.list",
    "compute.disks.list",
    "compute.firewalls.list",
    "compute.forwardingRules.list",
    "compute.healthChecks.list",
    // The instance-group lister reads aggregated instanceGroupManagers.
    "compute.instanceGroupManagers.list",
    "compute.instanceTemplates.list",
    "compute.instances.list",
    "compute.networks.list",
    "compute.routers.list",
    "compute.securityPolicies.list",
    "compute.sslCertificates.list",
    "compute.subnetworks.list",
    "container.clusters.list",
    "dataflow.jobs.list",
    "datastore.databases.list",
    "dns.managedZones.list",
    "dns.resourceRecordSets.list",
    "file.instances.list",
    "iam.serviceAccounts.list",
    "logging.sinks.list",
    "memcache.instances.list",
    "monitoring.alertPolicies.list",
    "pubsub.subscriptions.list",
    "pubsub.topics.list",
    "redis.instances.list",
    "resourcemanager.projects.get",
    "run.services.list",
    "secretmanager.secrets.list",
    "spanner.backups.list",
    "spanner.databases.list",
    "spanner.instances.list",
    "storage.buckets.list",
    "workflows.workflows.list",
  ],
  metrics: METRICS_PERMISSIONS.map((p) => p.id),
  costs: COSTS_PERMISSIONS.map((p) => p.id),
};

/** Build the paste-ready custom role definition for the selected capabilities. */
export function buildGcpPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = gcpPreflight.capabilities.filter((c) => capabilityIds.includes(c.id));
  const permissions = Array.from(
    new Set(
      selected.flatMap((c) => TEMPLATE_PERMISSIONS[c.id] ?? c.requiredPermissions.map((p) => p.id)),
    ),
  ).sort();
  const labels = selected.map((c) => c.label.toLowerCase()).join(", ");
  const lines = [
    `title: "Infrawrench"`,
    `description: "Least-privilege role for the Infrawrench service account: ${labels}."`,
    `stage: "GA"`,
    "includedPermissions:",
    ...permissions.map((p) => `- ${p}`),
  ];
  return {
    formatLabel: "GCP custom role (YAML)",
    language: "yaml",
    document: `${lines.join("\n")}\n`,
    instructions:
      "Save as role.yaml, create it with `gcloud iam roles create infrawrench --project=YOUR_PROJECT --file=role.yaml`, then grant the role to the service account whose key you pasted. Cost reporting also needs the role (or BigQuery Data Viewer) on the billing export dataset.",
    helpLink: IAM_HELP_LINK,
  };
}

interface TestIamPermissionsResponse {
  permissions?: string[];
}

/** Defensive chunk size — the docs specify no cap, but keep requests small. */
const TEST_CHUNK = 100;

async function testIamPermissions(
  key: ServiceAccountKey,
  project: string,
  permissions: string[],
): Promise<Set<string>> {
  const token = await fetchAccessToken(key);
  const granted = new Set<string>();
  for (let i = 0; i < permissions.length; i += TEST_CHUNK) {
    const chunk = permissions.slice(i, i + TEST_CHUNK);
    const res = await fetch(
      `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(project)}:testIamPermissions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: chunk }),
      },
    );
    if (!res.ok) {
      throw new Error(`testIamPermissions failed: ${res.status} — ${await res.text()}`);
    }
    const body = (await res.json()) as TestIamPermissionsResponse;
    for (const p of body.permissions ?? []) granted.add(p);
  }
  return granted;
}

function shortMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > 300 ? `${raw.slice(0, 299)}…` : raw;
}

export async function runGcpPreflight(
  key: ServiceAccountKey,
  project: string,
  billingExportTable: string,
): Promise<PreflightResult> {
  const capabilities = gcpPreflight.capabilities;
  const allPermissions = capabilities.flatMap((c) => c.requiredPermissions.map((p) => p.id));

  let granted: Set<string>;
  try {
    granted = await testIamPermissions(key, project, allPermissions);
  } catch (e) {
    return {
      identity: key.client_email,
      checks: capabilities.map((c) => ({
        capabilityId: c.id,
        status: "unknown" as const,
        message: shortMessage(e),
      })),
    };
  }

  const checks: PreflightCapabilityCheck[] = capabilities.map((c) => {
    const missing = c.requiredPermissions.filter((p) => !granted.has(p.id));
    if (missing.length > 0) {
      return {
        capabilityId: c.id,
        status: "missing" as const,
        missingPermissions: missing,
        helpLink: IAM_HELP_LINK,
      };
    }
    return { capabilityId: c.id, status: "ok" as const };
  });

  // Cost reporting has a setup prerequisite beyond IAM: the billing export
  // table must exist and be configured on the account.
  if (!billingExportTable) {
    const idx = checks.findIndex((c) => c.capabilityId === "costs");
    if (idx !== -1) {
      // Both failure states matter: keep any IAM permissions the probe already
      // found missing and add the setup-step message on top.
      const prior = checks[idx]!;
      checks[idx] = {
        capabilityId: "costs",
        status: "missing",
        missingPermissions: prior.status === "missing" ? prior.missingPermissions : [],
        message:
          'The "Billing export table" field is blank. Enable the Cloud Billing "standard usage cost" export to BigQuery and enter the table as project.dataset.table.',
        helpLink: BILLING_EXPORT_HELP_LINK,
      };
    }
  }

  return { identity: key.client_email, checks };
}
