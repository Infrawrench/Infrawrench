import type {
  DetailViewSchema,
  DetailViewTab,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
  dnsZoneStatus,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import { buildDynamoSchemaTab, decodeIndexesField } from "./dynamodb-detail.js";

const DETAIL_STATUS_MAP: Record<string, ResourceStatus> = {
  // Generic
  running: "healthy",
  active: "healthy",
  "in-use": "healthy",
  available: "healthy",
  issued: "healthy",
  ok: "healthy",
  enabled: "healthy",
  // Degraded / stopped
  stopped: "degraded",
  stopping: "degraded",
  paused: "degraded",
  disabled: "degraded",
  inactive: "degraded",
  insufficient_data: "degraded",
  // Provisioning / in-progress
  pending: "provisioning",
  creating: "provisioning",
  updating: "provisioning",
  provisioning: "provisioning",
  create_in_progress: "provisioning",
  update_in_progress: "provisioning",
  operation_in_progress: "provisioning",
  pending_validation: "provisioning",
  // Error
  "shutting-down": "error",
  terminated: "error",
  deleting: "error",
  deleted: "error",
  failed: "error",
  create_failed: "error",
  delete_failed: "error",
  rollback_complete: "error",
  rollback_failed: "error",
  alarm: "error",
  revoked: "error",
  expired: "error",
};

const SIDEBAR_STATUS_MAP: Record<string, ResourceStatus> = {
  running: "healthy",
  active: "healthy",
  available: "healthy",
  "in-use": "healthy",
  issued: "healthy",
  ok: "healthy",
  enabled: "healthy",
  stopped: "degraded",
  paused: "degraded",
  disabled: "degraded",
  terminated: "error",
  failed: "error",
  deleted: "error",
  alarm: "error",
};

export function renderDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
  region: string,
): DetailViewSchema {
  if (resource.resourceTypeId === "route53-record-set") {
    return renderDnsRecordDetail(resource, {});
  }

  const fields = resource.fields;
  // SNS topics and SQS queues have no lifecycle state — if they exist, they
  // are active. Treat a missing state as "active" so the dot renders healthy.
  const alwaysHealthyTypes = new Set(["sns-topic", "sqs-queue"]);
  const state = String(
    fields["state"] ??
      fields["status"] ??
      (alwaysHealthyTypes.has(resource.resourceTypeId) ? "active" : ""),
  );

  const dotStatus = DETAIL_STATUS_MAP[state.toLowerCase()] ?? "info";

  // Plugin-private fields are prefixed with an underscore so the lister can
  // smuggle structured payloads (e.g. DynamoDB index JSON) through the
  // resource without them leaking into the generic Details key-value list.
  const visibleFields: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith("_")) visibleFields[k] = v;
  }

  // DynamoDB tables get an extra "Schema & indexes" tab with GSI add/delete
  // actions. Built here (not inline below) so the underlying _indexesJson
  // field stays in one place.
  const dynamoCustomTabs: DetailViewTab[] =
    resource.resourceTypeId === "dynamodb-table"
      ? [buildDynamoSchemaTab(decodeIndexesField(fields["_indexesJson"]))]
      : [];

  return {
    title: resource.displayName,
    subtitle: `${resourceTypeDisplayName(resourceTypes, resource.resourceTypeId)} · ${region}`,
    status: state
      ? { kind: "status-dot", status: dotStatus, label: state }
      : { kind: "status-dot", status: dotStatus },
    sections: [
      {
        kind: "section",
        title: "Details",
        children: [
          {
            kind: "key-value-list",
            items: labeledFieldItems(visibleFields, resourceTypes, resource.resourceTypeId),
          },
        ],
      },
      ...(() => {
        const outputItems = labeledOutputItems(
          resource.resolvedOutputs,
          resourceTypes,
          resource.resourceTypeId,
        );
        return outputItems.length > 0
          ? [
              {
                kind: "section" as const,
                title: "Outputs",
                children: [{ kind: "key-value-list" as const, items: outputItems }],
              },
            ]
          : [];
      })(),
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    ...(resource.resourceTypeId === "ecr-repository"
      ? {
          artifactRegistry: {
            format: "docker" as const,
            supportsTags: true,
          },
        }
      : {}),
    ...(resource.resourceTypeId === "dynamodb-table"
      ? {
          noSqlBrowser: {
            driver: "dynamodb" as const,
            databaseLabel: String(fields["tableName"] ?? resource.externalId ?? ""),
            singleCollection: true,
            helpText:
              "Scan the table to browse items. Item keys are encoded into the `_name` field — strip it before re-inserting.",
          },
          customTabs: dynamoCustomTabs,
        }
      : {}),
    // DocumentDB is MongoDB-compatible — render the MongoDB peer browser
    // inline so users can browse collections without leaving the resource.
    // Note: DocumentDB clusters are VPC-only, so the user's MongoDB account
    // needs network reachability (jumpbox or peered VPC).
    ...(resource.resourceTypeId === "documentdb-cluster"
      ? {
          noSqlBrowser: {
            driver: "mongodb-peer" as const,
            databaseLabel: String(fields["clusterIdentifier"] ?? resource.externalId ?? ""),
            helpText:
              "DocumentDB speaks the MongoDB wire protocol. Link a MongoDB account in your sidebar (with VPC reachability to the cluster) to browse documents inline.",
          },
        }
      : {}),
  };
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  if (resource.resourceTypeId === "route53-record-set") {
    return renderDnsRecordSidebar(resource);
  }
  // Route 53 hosted zones use the shared dnsZoneStatus helper
  if (resource.resourceTypeId === "route53-hosted-zone") {
    const isPrivate = resource.fields["isPrivate"];
    const label = isPrivate ? "Private" : "Active";
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: dnsZoneStatus("active"), label },
    };
  }

  const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: SIDEBAR_STATUS_MAP[state.toLowerCase()] ?? "info" },
  };
}
