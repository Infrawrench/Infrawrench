import type {
  ActionNode,
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

/** Per-type confirm copy and stop suppression for the lifecycle pair. */
interface LifecycleActionCopy {
  stopConfirm: string;
  /**
   * Row-level guard — return false to hide Stop for resources the provider
   * would reject the call on.
   */
  canStop?: (fields: ResourceInstance["fields"]) => boolean;
}

const LIFECYCLE_ACTION_COPY: Record<string, LifecycleActionCopy> = {
  "ec2-instance": {
    stopConfirm:
      "Stop this EC2 instance? Compute billing stops while it is stopped; EBS volumes and Elastic IPs keep billing.",
  },
  "rds-instance": {
    stopConfirm:
      "Stop this RDS instance? Connections drop and instance-hour billing stops; storage keeps billing, and AWS restarts a stopped instance after 7 days.",
    // StopDBInstance is rejected for Aurora/DocumentDB/Neptune cluster
    // members (stop the cluster instead) and for Multi-AZ SQL Server
    // deployments — don't offer an action the API will refuse. (Read
    // replicas are also unstoppable, but the lister carries no field that
    // identifies them, so that rejection still surfaces as the provider's
    // own error.)
    canStop: (fields) => {
      if (String(fields["dbClusterIdentifier"] ?? "") !== "") return false;
      const multiAz = fields["multiAZ"] === true || String(fields["multiAZ"]) === "true";
      if (multiAz && String(fields["engine"] ?? "").startsWith("sqlserver")) return false;
      return true;
    },
  },
};

/**
 * Build the Stop/Start header actions from the type's `lifecycle`
 * declaration — action ids and state matching come from the declaration
 * (all declared running/stopped values), never from per-type conditionals.
 */
function buildLifecycleActions(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
  state: string,
  fields: ResourceInstance["fields"],
): ActionNode[] {
  const lifecycle = resourceTypes.find((t) => t.id === resource.resourceTypeId)?.lifecycle;
  if (!lifecycle) return [];
  const s = state.toLowerCase();
  const matches = (values?: string[]) => values?.some((v) => v.toLowerCase() === s) ?? false;
  const copy = LIFECYCLE_ACTION_COPY[resource.resourceTypeId];
  if (matches(lifecycle.runningValues)) {
    if (copy?.canStop && !copy.canStop(fields)) return [];
    return [
      {
        kind: "action",
        label: "Stop",
        action: {
          type: "plugin-action",
          actionId: lifecycle.stopActionId,
          ...(copy ? { confirmMessage: copy.stopConfirm } : {}),
          successMessage: "Stop requested.",
        },
        variant: "danger",
      },
    ];
  }
  if (matches(lifecycle.stoppedValues)) {
    return [
      {
        kind: "action",
        label: "Start",
        action: {
          type: "plugin-action",
          actionId: lifecycle.startActionId,
          successMessage: "Start requested.",
        },
      },
    ];
  }
  return [];
}

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

  // Stop/Start header actions driven by the type's own `lifecycle`
  // declaration: Stop while the state matches a declared running value,
  // Start while it matches a stopped one. Only the confirm copy (and any
  // per-resource stop suppression) is type-specific, keyed here.
  const lifecycleActions = buildLifecycleActions(resource, resourceTypes, state, fields);

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
    headerActions: [
      ...lifecycleActions,
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
    ...(resource.resourceTypeId === "ecr-repository"
      ? {
          artifactRegistry: {
            format: "docker" as const,
            supportsTags: true,
          },
        }
      : {}),
    ...(resource.resourceTypeId === "s3-bucket"
      ? (() => {
          const bucketName = resource.externalId ?? String(fields["name"] ?? resource.displayName);
          return {
            storageBrowser: { bucketName },
            bucketPolicyEditor: {
              bucketArn: `arn:aws:s3:::${bucketName}`,
              bucketName,
              vendor: "aws-s3" as const,
            },
          };
        })()
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
    ...(resource.resourceTypeId === "bedrock-model"
      ? {
          chatPanel: {
            tabLabel: "Playground",
            subtitle: `Chat with ${String(fields["modelName"] ?? resource.displayName)}`,
            greeting:
              "Send a prompt to try this Bedrock foundation model via the Converse API. " +
              "Responses come back as a single whole message (non-streaming), and the full " +
              "conversation history is sent on each turn.",
            inputPlaceholder: "Send a message…",
          },
        }
      : {}),
    ...(resource.resourceTypeId === "sqs-queue"
      ? {
          publishPanel: {
            tabLabel: "Send",
            subtitle: `Send a test message to ${resource.displayName}`,
            bodyFormat: "json" as const,
            defaultBody: '{\n  "hello": "world"\n}',
            helpText:
              "Posted as the `MessageBody` of a single SendMessage call. JSON is sent as a string — consumers parse it themselves.",
            submitLabel: "Send message",
            extraFields: [
              {
                key: "delaySeconds",
                label: "Delay (seconds)",
                kind: "number" as const,
                optional: true,
                placeholder: "0",
                helpText: "0–900. Maps to `DelaySeconds` on SendMessage.",
              },
              {
                key: "messageGroupId",
                label: "Message Group Id",
                kind: "text" as const,
                optional: true,
                helpText: "Required for FIFO queues. Leave blank for standard queues.",
              },
              {
                key: "attributes",
                label: "Message attributes",
                kind: "key-value-list" as const,
                helpText:
                  "Each entry becomes a String-typed MessageAttribute on the SendMessage call.",
              },
            ],
          },
        }
      : {}),
    ...(resource.resourceTypeId === "sns-topic"
      ? {
          publishPanel: {
            tabLabel: "Publish",
            subtitle: `Publish to ${resource.displayName}`,
            bodyFormat: "text" as const,
            defaultBody: "Hello from Infrawrench.",
            helpText:
              "Posted via SNS Publish. Pass JSON in the body if your subscribers expect structured data.",
            submitLabel: "Publish",
            extraFields: [
              {
                key: "subject",
                label: "Subject",
                kind: "text" as const,
                optional: true,
                helpText: "Optional — used by email subscribers as the email subject.",
              },
              {
                key: "attributes",
                label: "Message attributes",
                kind: "key-value-list" as const,
                helpText: "String-typed attributes attached to the message.",
              },
            ],
          },
        }
      : {}),
    ...(resource.resourceTypeId === "kinesis-stream"
      ? {
          publishPanel: {
            tabLabel: "Put record",
            subtitle: `Put a record into ${resource.displayName}`,
            bodyFormat: "json" as const,
            defaultBody: '{\n  "event": "test"\n}',
            helpText:
              "Posted via Kinesis PutRecord. The body is base64-encoded and sent as the record `Data`.",
            submitLabel: "Put record",
            extraFields: [
              {
                key: "partitionKey",
                label: "Partition key",
                kind: "text" as const,
                placeholder: "user-123",
                helpText: "Used by Kinesis to assign the record to a shard.",
              },
            ],
          },
        }
      : {}),
    ...(resource.resourceTypeId === "eventbridge-rule"
      ? {
          publishPanel: {
            tabLabel: "Put event",
            subtitle: `Put an event onto the bus matched by ${resource.displayName}`,
            bodyFormat: "json" as const,
            defaultBody: '{\n  "userId": "abc-123",\n  "action": "test"\n}',
            helpText:
              "Posted via EventBridge PutEvents. The body becomes the event `Detail`. Rules match on Source + DetailType.",
            submitLabel: "Put event",
            extraFields: [
              {
                key: "source",
                label: "Source",
                kind: "text" as const,
                placeholder: "infrawrench.test",
                helpText: "Required. EventBridge uses this for rule matching.",
              },
              {
                key: "detailType",
                label: "Detail type",
                kind: "text" as const,
                placeholder: "test-event",
                helpText: "Required. Pairs with Source for rule matching.",
              },
              {
                key: "eventBusName",
                label: "Event bus name",
                kind: "text" as const,
                optional: true,
                helpText: "Defaults to the bus the rule lives on, or `default`.",
              },
            ],
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
