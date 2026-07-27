import type { GcpClientContext } from "./shared.js";

/**
 * Dispatcher for every `deleteResource` call. Each branch resolves the
 * resource (so we have the up-to-date fields and externalId) and issues the
 * appropriate `DELETE` (or `PATCH`, for sub-resources like Cloud NAT) against
 * the relevant GCP API.
 */
export async function deleteResource(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
): Promise<void> {
  const p = ctx.project;
  const tok = await ctx.token();

  if (typeId === "gce-instance") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const zone = String(resource.fields["zone"] ?? "");
    const name = String(
      resource.fields["name"] ??
        (resource.externalId ?? resource.displayName).split("/").pop() ??
        "",
    );
    if (!zone || !name) throw new Error("Cannot determine zone or instance name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instances/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "gke-cluster") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const location = String(resource.fields["location"] ?? "");
    const name = resource.externalId ?? resource.displayName;
    if (!location || !name)
      throw new Error("Cannot determine location or cluster name for deletion");
    const res = await fetch(
      `https://container.googleapis.com/v1/projects/${p}/locations/${location}/clusters/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GKE API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "gce-disk") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const zone = String(resource.fields["zone"] ?? "");
    const name = String(resource.fields["name"] ?? "");
    if (!zone || !name) throw new Error("Cannot determine zone or disk name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/disks/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloudsql-instance") {
    // resourceId format is `<accountId>:cloudsql-instance:<name>` and the
    // instance name is all we need for the DELETE — skip the listResources
    // round-trip that `ctx.getResource` does. Adds an AbortController-backed
    // timeout so the DELETE doesn't hang the UI indefinitely if Cloud SQL's
    // API stalls. The API returns immediately with an Operation; the actual
    // deletion runs async on Google's side.
    const name = resourceId.split(":").slice(2).join(":") || "";
    if (!name) throw new Error("Cannot determine Cloud SQL instance name for deletion");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${p}/instances/${name}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          "Cloud SQL DELETE timed out after 30s. The deletion may still complete in Google Cloud — refresh in a minute to confirm.",
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Cloud SQL API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-run-service") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://run.googleapis.com/v2/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Cloud Run API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-function") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://cloudfunctions.googleapis.com/v2/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Cloud Functions API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "pubsub-topic") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "pubsub-subscription") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "secret-manager-secret") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://secretmanager.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "firewall-rule") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? resource.externalId ?? "");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "static-ip") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    const region = String(resource.fields["region"] ?? "");
    if (!name || !region) throw new Error("Cannot determine name or region for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/addresses/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-scheduler-job") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Cloud Scheduler API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-tasks-queue") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://cloudtasks.googleapis.com/v2/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Cloud Tasks API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "artifact-registry-repo") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://artifactregistry.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Artifact Registry API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "workflow") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://workflows.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Workflows API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "filestore-instance") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    const res = await fetch(`https://file.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Filestore API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "gcs-bucket") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? resource.externalId ?? "");
    if (!name) throw new Error("Cannot determine bucket name for deletion");
    const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`GCS API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "spanner-instance") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.externalId ?? resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine Spanner instance name for deletion");
    const res = await fetch(`https://spanner.googleapis.com/v1/projects/${p}/instances/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "spanner-database") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const extId = String(resource.externalId ?? "");
    const [instance, name] = extId.split("/");
    if (!instance || !name)
      throw new Error("Cannot determine Spanner database identity for deletion");
    const res = await fetch(
      `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/databases/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "spanner-backup") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const extId = String(resource.externalId ?? "");
    const [instance, name] = extId.split("/");
    if (!instance || !name)
      throw new Error("Cannot determine Spanner backup identity for deletion");
    const res = await fetch(
      `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/backups/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "bigtable-instance") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.externalId ?? resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine Bigtable instance name for deletion");
    const res = await fetch(
      `https://bigtableadmin.googleapis.com/v2/projects/${p}/instances/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`Bigtable API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "firestore-database") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.externalId ?? resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine Firestore database name for deletion");
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${p}/databases/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Firestore API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "memorystore-redis") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    if (!fullName) throw new Error("Cannot determine Redis instance name for deletion");
    const res = await fetch(`https://redis.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Memorystore Redis API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "alloydb-cluster") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    if (!fullName) throw new Error("Cannot determine AlloyDB cluster name for deletion");
    const res = await fetch(`https://alloydb.googleapis.com/v1/${fullName}?force=true`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "alloydb-instance") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    if (!fullName) throw new Error("Cannot determine AlloyDB instance name for deletion");
    const res = await fetch(`https://alloydb.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "memorystore-memcached") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    if (!fullName) throw new Error("Cannot determine Memcached instance name for deletion");
    const res = await fetch(`https://memcache.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Memorystore Memcached API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "vpc-network") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine VPC network name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "subnet") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    const region = String(resource.fields["region"] ?? "");
    if (!name || !region) throw new Error("Cannot determine name or region for subnet deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/subnetworks/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-router") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    const region = String(resource.fields["region"] ?? "");
    if (!name || !region) throw new Error("Cannot determine name or region for router deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-nat") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const region = String(resource.fields["region"] ?? "");
    const routerName = String(resource.fields["router"] ?? "");
    const natName = String(resource.fields["name"] ?? "");
    if (!region || !routerName || !natName)
      throw new Error("Cannot determine region, router, or NAT name for deletion");
    // Cloud NAT is a sub-resource of the router — fetch the router, remove this NAT, then patch
    const routerUrl = `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`;
    const routerRes = await fetch(routerUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!routerRes.ok)
      throw new Error(`GCP Compute API ${routerRes.status}: ${await routerRes.text()}`);
    const routerData = (await routerRes.json()) as Record<string, unknown>;
    const nats = routerData["nats"] as Array<Record<string, unknown>> | undefined;
    routerData["nats"] = (nats ?? []).filter((n) => String(n["name"]) !== natName);
    const patchRes = await fetch(routerUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(routerData),
    });
    if (!patchRes.ok)
      throw new Error(`GCP Compute API ${patchRes.status}: ${await patchRes.text()}`);
    return;
  }

  if (typeId === "cloud-armor-policy") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine Cloud Armor policy name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "backend-service") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? resource.externalId ?? "");
    if (!name) throw new Error("Cannot determine backend service name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/backendServices/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "forwarding-rule") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    const region = String(resource.fields["region"] ?? "");
    if (!name) throw new Error("Cannot determine forwarding rule name for deletion");
    const url =
      region && region !== "global"
        ? `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/forwardingRules/${name}`
        : `https://compute.googleapis.com/compute/v1/projects/${p}/global/forwardingRules/${name}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "health-check") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? resource.externalId ?? "");
    if (!name) throw new Error("Cannot determine health check name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/healthChecks/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "ssl-certificate") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? resource.externalId ?? "");
    if (!name) throw new Error("Cannot determine SSL certificate name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/sslCertificates/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-dns-zone") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.externalId ?? resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine DNS zone name for deletion");
    const res = await fetch(
      `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-dns-record-set") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    // externalId is "{zoneName}/{type}:{recordName}"
    const extId = resource.externalId ?? "";
    const slashIdx = extId.indexOf("/");
    const zoneName = extId.slice(0, slashIdx);
    const rest = extId.slice(slashIdx + 1);
    const colonIdx = rest.indexOf(":");
    const rrType = rest.slice(0, colonIdx);
    const rrName = rest.slice(colonIdx + 1);
    if (!zoneName || !rrType || !rrName)
      throw new Error("Cannot determine zone, type, or name for DNS record set deletion");
    // Cloud DNS requires the trailing dot on the record name
    const fqdn = rrName.endsWith(".") ? rrName : `${rrName}.`;
    const res = await fetch(
      `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${zoneName}/rrsets/${fqdn}/${rrType}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "bigquery-dataset") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    // externalId is "{project}:{datasetId}"
    const extId = resource.externalId ?? "";
    const datasetId = extId.split(":").pop() ?? String(resource.fields["name"] ?? "");
    if (!datasetId) throw new Error("Cannot determine dataset ID for deletion");
    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}?deleteContents=true`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "bigquery-table") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    // externalId is "{project}:{datasetId}/{tableId}"
    const extId = resource.externalId ?? "";
    const [projectPart, rest] = extId.split(":", 2);
    const [datasetId, tableId] = (rest ?? "").split("/");
    const proj = projectPart || p;
    if (!datasetId || !tableId) throw new Error("Cannot determine table ID for deletion");
    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${proj}/datasets/${datasetId}/tables/${tableId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "dataflow-job") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const jobId = String(resource.externalId ?? "");
    const region = String(resource.fields["region"] ?? "");
    if (!jobId) throw new Error("Cannot determine Dataflow job ID for cancellation");
    // Dataflow jobs are cancelled, not deleted
    const url = region
      ? `https://dataflow.googleapis.com/v1b3/projects/${p}/locations/${region}/jobs/${jobId}`
      : `https://dataflow.googleapis.com/v1b3/projects/${p}/jobs/${jobId}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requestedState: "JOB_STATE_CANCELLED" }),
    });
    if (!res.ok) throw new Error(`Dataflow API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-build-trigger") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    // externalId is `<region>/<triggerId>` for resources produced by the
    // current lister/create handler. Pre-regional rows just stored
    // `<triggerId>` — fall back to the global endpoint for those.
    const externalId = String(resource.externalId ?? "");
    if (!externalId) throw new Error("Cannot determine Cloud Build trigger ID for deletion");
    const slashIdx = externalId.indexOf("/");
    const region = slashIdx > 0 ? externalId.slice(0, slashIdx) : "global";
    const triggerId = slashIdx > 0 ? externalId.slice(slashIdx + 1) : externalId;
    const url =
      region === "global"
        ? `https://cloudbuild.googleapis.com/v1/projects/${p}/triggers/${triggerId}`
        : `https://cloudbuild.googleapis.com/v1/projects/${p}/locations/${region}/triggers/${triggerId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Cloud Build API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "cloud-deploy-pipeline") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    if (!fullName) throw new Error("Cannot determine Cloud Deploy pipeline name for deletion");
    const res = await fetch(`https://clouddeploy.googleapis.com/v1/${fullName}?force=true`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Cloud Deploy API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "composer-environment") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    if (!fullName) throw new Error("Cannot determine Composer environment name for deletion");
    const res = await fetch(`https://composer.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Composer API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "vertex-ai-endpoint") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    // fullName is like projects/p/locations/region/endpoints/id — extract region for regional endpoint
    const region = String(
      resource.fields["region"] ?? fullName.split("/locations/")[1]?.split("/")[0] ?? "",
    );
    if (!fullName || !region)
      throw new Error("Cannot determine Vertex AI endpoint name or region for deletion");
    const res = await fetch(`https://${region}-aiplatform.googleapis.com/v1/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Vertex AI API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "gcp-service-account") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const email = String(resource.externalId ?? resource.fields["email"] ?? "");
    if (!email) throw new Error("Cannot determine service account email for deletion");
    const res = await fetch(
      `https://iam.googleapis.com/v1/projects/${p}/serviceAccounts/${email}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`IAM API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "log-sink") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.externalId ?? resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine log sink name for deletion");
    const res = await fetch(`https://logging.googleapis.com/v2/projects/${p}/sinks/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Logging API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "alert-policy") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fullName = resource.externalId ?? "";
    if (!fullName) throw new Error("Cannot determine alert policy name for deletion");
    const res = await fetch(`https://monitoring.googleapis.com/v3/${fullName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Monitoring API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "instance-group") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    const zone = String(resource.fields["zone"] ?? "");
    const region = String(resource.fields["region"] ?? "");
    if (!name) throw new Error("Cannot determine instance group name for deletion");
    // Managed instance groups can be zonal or regional
    const url = zone
      ? `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroupManagers/${name}`
      : region
        ? `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/instanceGroupManagers/${name}`
        : (() => {
            throw new Error("Cannot determine zone or region for instance group deletion");
          })();
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  if (typeId === "kms-key") {
    // Cloud KMS doesn't delete keys — it only destroys their versions.
    // Schedule destruction of every version that isn't already destroyed.
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const keyName = resource.externalId ?? "";
    if (!keyName) throw new Error("Cannot determine KMS key name for deletion");
    const versions = await ctx.paginate<{ name?: string; state?: string }>(
      `https://cloudkms.googleapis.com/v1/${keyName}/cryptoKeyVersions`,
      "cryptoKeyVersions",
    );
    const active = versions.filter(
      (v) => v.state !== "DESTROYED" && v.state !== "DESTROY_SCHEDULED" && v.name,
    );
    if (active.length === 0) return;
    const results = await Promise.all(
      active.map((v) =>
        fetch(`https://cloudkms.googleapis.com/v1/${v.name}:destroy`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: "{}",
        }),
      ),
    );
    for (const res of results) {
      if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
    }
    return;
  }

  if (typeId === "kms-key-ring") {
    throw new Error(
      "Cloud KMS does not support deleting key rings. Key rings remain in the project indefinitely; you can only destroy the keys inside them.",
    );
  }

  if (typeId === "instance-template") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const name = resource.externalId ?? String(resource.fields["name"] ?? "");
    if (!name) throw new Error("Cannot determine instance template name for deletion");
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/instanceTemplates/${name}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }

  throw new Error(`GCP plugin: deleteResource not supported for type "${typeId}"`);
}
