/**
 * GCP detail-view dispatcher.
 *
 * `gcpRenderDetail` builds a base `DetailViewSchema` from the generic
 * resource fields, then delegates to a per-service renderer (in a sibling
 * `<service>-detail-renderers.ts` file) that mutates `base` in place. Small
 * single-line tweaks (e.g. memorystore-redis status, secret-manager-secret
 * versions config) stay inline here.
 *
 * Public surface: `GcpDetailContext` and `gcpRenderDetail`. Both are used
 * by `client.ts`.
 */
import type { DetailViewSchema, ResourceInstance, SqlTableMeta } from "@infrawrench/plugin-base";
import { labeledFieldItems } from "@infrawrench/plugin-base";
import { gcpStatus } from "./utils.js";
import { renderBigQueryDataset, renderBigQueryTable } from "./bigquery-detail-renderers.js";
import { renderCloudArmorPolicy } from "./cloud-armor-detail-renderers.js";
import { renderCloudFunction, renderCloudRunService } from "./cloud-run-detail-renderers.js";
import { renderCloudTasksQueue } from "./cloud-tasks-detail-renderers.js";
import { renderCloudDnsRecordSet, renderCloudDnsZone } from "./dns-detail-renderers.js";
import { renderFirestoreDatabase } from "./firestore-detail-renderers.js";
import { renderCloudNat, renderCloudRouter } from "./network-detail-renderers.js";
import { renderPubsubSubscription, renderPubsubTopic } from "./pubsub-detail-renderers.js";

export type { GcpDetailContext } from "./detail-context.js";
import type { GcpDetailContext } from "./detail-context.js";

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
    renderBigQueryDataset(resource, base);
  }

  if (resource.resourceTypeId === "bigquery-table") {
    renderBigQueryTable(resource, base);
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
    renderCloudDnsZone(resource, base);
  }

  if (resource.resourceTypeId === "cloud-dns-record-set") {
    renderCloudDnsRecordSet(resource, base);
  }

  // Pub/Sub topics and subscriptions have no lifecycle state in the GCP API —
  // if the resource exists, it's active. Give them a healthy dot so the UI
  // doesn't fall through to "unknown" grey.
  if (resource.resourceTypeId === "pubsub-topic") {
    renderPubsubTopic(resource, base);
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
    renderCloudTasksQueue(resource, base);
  }

  if (resource.resourceTypeId === "firestore-database") {
    renderFirestoreDatabase(resource, base);
  }

  if (resource.resourceTypeId === "cloud-run-service") {
    renderCloudRunService(resource, base);
  }

  if (resource.resourceTypeId === "cloud-function") {
    renderCloudFunction(resource, base);
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
    renderCloudRouter(resource, base);
  }

  if (resource.resourceTypeId === "cloud-nat") {
    renderCloudNat(resource, base);
  }

  if (resource.resourceTypeId === "cloud-armor-policy") {
    renderCloudArmorPolicy(resource, base);
  }

  if (resource.resourceTypeId === "pubsub-subscription") {
    renderPubsubSubscription(ctx, resource, base);
  }

  return base;
}
