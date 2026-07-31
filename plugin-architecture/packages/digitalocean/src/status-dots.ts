/**
 * Status-dot mapping for DigitalOcean resources. The host gates SSH/SFTP and
 * other affordances on `healthy`, so each product's vendor status vocabulary
 * gets its own translation rather than a shared string match.
 */
import type { ResourceInstance, StatusDotNode } from "@infrawrench/plugin-base";

/**
 * Map a DigitalOcean Droplet's `status` value to a host status-dot. `active`
 * marks the droplet "healthy" — the host gates SSH/SFTP affordances on that.
 * See https://docs.digitalocean.com/reference/api/api-reference/#operation/droplets_list
 */
function dropletStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "active":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "new":
      return { kind: "status-dot", status: "provisioning", label: "Provisioning" };
    case "off":
      return { kind: "status-dot", status: "unknown", label: "Off" };
    case "archive":
      return { kind: "status-dot", status: "info", label: "Archived" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Map a DOKS cluster's `status.state` value to a host status-dot.
 * Source enum: running / provisioning / degraded / error / deleted /
 * deleting / upgrading
 * (per cluster_read.yml in digitalocean/openapi).
 */
function doksStatusDot(state: string): StatusDotNode {
  switch (state) {
    case "running":
      return { kind: "status-dot", status: "healthy", label: "Running" };
    case "provisioning":
      return { kind: "status-dot", status: "provisioning", label: "Provisioning" };
    case "upgrading":
      return { kind: "status-dot", status: "provisioning", label: "Upgrading" };
    case "degraded":
      return { kind: "status-dot", status: "degraded", label: "Degraded" };
    case "error":
      return { kind: "status-dot", status: "error", label: "Error" };
    case "deleting":
      return { kind: "status-dot", status: "provisioning", label: "Deleting" };
    case "deleted":
      return { kind: "status-dot", status: "info", label: "Deleted" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Volumes don't have a documented status field on the response (verified in
 * digitalocean/openapi/volumes/models/volume_base.yml). The closest signal
 * for "in use vs free" is the `droplet_ids` array — non-empty = attached.
 * Both attached and detached are operational ("healthy") for the purpose
 * of the host's status gating; the label just disambiguates.
 */
function volumeStatusDot(attached: boolean): StatusDotNode {
  return attached
    ? { kind: "status-dot", status: "healthy", label: "Attached" }
    : { kind: "status-dot", status: "healthy", label: "Available" };
}

/**
 * Reserved IPs have no status field either (schema `reserved_ip`: ip, region,
 * droplet, locked, project_id). `locked` means DO has an action still running;
 * an unassigned address is operational but costs money, so it gets the
 * "degraded" dot to make it visible in a long sidebar list — which is the same
 * thing the orphan finder flags on the Costs page.
 */
function reservedIpStatusDot(fields: Record<string, string | number | boolean>): StatusDotNode {
  if (fields["locked"] === true || String(fields["locked"] ?? "") === "true") {
    return { kind: "status-dot", status: "provisioning", label: "Pending action" };
  }
  return String(fields["dropletId"] ?? "")
    ? { kind: "status-dot", status: "healthy", label: "Assigned" }
    : { kind: "status-dot", status: "degraded", label: "Unassigned" };
}

/**
 * Map a DO managed-database `status` value to a host status-dot.
 * Source enum: creating / online / resizing / migrating / forking
 * (per database_cluster_read.yml in digitalocean/openapi).
 */
function managedDatabaseStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "online":
      return { kind: "status-dot", status: "healthy", label: "Online" };
    case "creating":
      return { kind: "status-dot", status: "provisioning", label: "Creating" };
    case "resizing":
      return { kind: "status-dot", status: "provisioning", label: "Resizing" };
    case "migrating":
      return { kind: "status-dot", status: "provisioning", label: "Migrating" };
    case "forking":
      return { kind: "status-dot", status: "provisioning", label: "Forking" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Map a DO custom-image `status` value to a host status-dot.
 * Source enum: NEW / available / pending / deleted / retired
 * (per images/models/image.yml in digitalocean/openapi).
 */
function imageStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "available":
      return { kind: "status-dot", status: "healthy", label: "Available" };
    case "NEW":
    case "pending":
      return { kind: "status-dot", status: "provisioning", label: "Pending" };
    case "deleted":
      return { kind: "status-dot", status: "info", label: "Deleted" };
    case "retired":
      return { kind: "status-dot", status: "info", label: "Retired" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Map a DO NFS share `status` value to a host status-dot.
 * Source enum: CREATING / ACTIVE / FAILED / DELETED
 * (per nfs/models/nfs_response.yml in digitalocean/openapi).
 */
function nfsShareStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "ACTIVE":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "CREATING":
      return { kind: "status-dot", status: "provisioning", label: "Creating" };
    case "FAILED":
      return { kind: "status-dot", status: "error", label: "Failed" };
    case "DELETED":
      return { kind: "status-dot", status: "info", label: "Deleted" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Dispatch a resource to its per-type status-dot mapper. Single place so
 * `renderDetail` and `renderSidebarItem` agree on what to show, and adding
 * a new resource type is a one-line case.
 */
export function doStatusDot(resource: ResourceInstance): StatusDotNode {
  const fields = resource.fields;
  switch (resource.resourceTypeId) {
    case "droplet":
      return dropletStatusDot(String(fields["status"] ?? ""));
    case "doks-cluster":
      return doksStatusDot(String(fields["status"] ?? ""));
    case "managed-database":
      return managedDatabaseStatusDot(String(fields["status"] ?? ""));
    case "image":
      return imageStatusDot(String(fields["status"] ?? ""));
    case "nfs-share":
      return nfsShareStatusDot(String(fields["status"] ?? ""));
    case "volume":
      return volumeStatusDot(!!String(fields["dropletIds"] ?? ""));
    case "reserved-ip":
      return reservedIpStatusDot(fields);
    case "domain":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "gen-ai-agent": {
      const status = String(fields["status"] ?? "").toLowerCase();
      if (status.includes("running") || status === "active" || status === "deployed") {
        return { kind: "status-dot", status: "healthy", label: "Deployed" };
      }
      if (status.includes("provision") || status.includes("creat")) {
        return { kind: "status-dot", status: "provisioning", label: "Provisioning" };
      }
      if (status.includes("error") || status.includes("fail")) {
        return { kind: "status-dot", status: "error", label: status || "Error" };
      }
      return { kind: "status-dot", status: "info", label: status || "Unknown" };
    }
    case "gen-ai-knowledge-base": {
      const status = String(fields["lastIndexingStatus"] ?? "").toLowerCase();
      if (status === "indexing_status_completed" || status === "completed") {
        return { kind: "status-dot", status: "healthy", label: "Indexed" };
      }
      if (status.includes("indexing") || status.includes("pending")) {
        return { kind: "status-dot", status: "provisioning", label: "Indexing" };
      }
      if (status.includes("error") || status.includes("fail")) {
        return { kind: "status-dot", status: "error", label: "Indexing failed" };
      }
      return { kind: "status-dot", status: "info", label: "Ready" };
    }
    case "gen-ai-model-router":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "dedicated-inference": {
      const status = String(fields["status"] ?? "");
      switch (status) {
        case "active":
          return { kind: "status-dot", status: "healthy", label: "Active" };
        case "provisioning":
        case "new":
        case "updating":
          return { kind: "status-dot", status: "provisioning", label: status };
        case "deleting":
          return { kind: "status-dot", status: "provisioning", label: "Deleting" };
        case "error":
          return { kind: "status-dot", status: "error", label: "Error" };
        default:
          return { kind: "status-dot", status: "info", label: status || "Unknown" };
      }
    }
    case "inference-batch": {
      const status = String(fields["status"] ?? "");
      switch (status) {
        case "completed":
          return { kind: "status-dot", status: "healthy", label: "Completed" };
        case "in_progress":
        case "validating":
        case "finalizing":
          return { kind: "status-dot", status: "provisioning", label: status };
        case "cancelling":
          return { kind: "status-dot", status: "provisioning", label: "Cancelling" };
        case "cancelled":
          return { kind: "status-dot", status: "info", label: "Cancelled" };
        case "expired":
          return { kind: "status-dot", status: "degraded", label: "Expired" };
        case "failed":
          return { kind: "status-dot", status: "error", label: "Failed" };
        default:
          return { kind: "status-dot", status: "info", label: status || "Unknown" };
      }
    }
    case "model-api-key":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}
