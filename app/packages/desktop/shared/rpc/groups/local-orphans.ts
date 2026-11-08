/**
 * Local-mode potential savings: the cloud's orphan scan over this machine's
 * SQLite workspace (see `electron/local-orphans.ts`). There is no billing data
 * locally, so the answer always carries `costBasis: "unavailable"`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  FindingRemediation,
  IacRemediationHint,
  IdleMetricEvidence,
  IdleSavingsEstimate,
  OrphanAccountGroup,
  OrphanedResource,
  OrphanIdleDetail,
  OrphanListResponse as OrphanListResponseType,
  RemediationCommand,
  RemediationPlaceholder,
  ResourceOwnerAnnotation,
} from "@infrawrench/plugin-base";
import { exact } from "../exact";
import { LocalWorkspaceError } from "../errors";

const RemediationPlaceholder = exact<RemediationPlaceholder>()(
  Schema.Struct({ name: Schema.String, description: Schema.String }),
);

const RemediationCommand = exact<RemediationCommand>()(
  Schema.Struct({
    tool: Schema.String,
    command: Schema.String,
    description: Schema.String,
    destructive: Schema.Boolean,
    placeholders: Schema.optionalKey(Schema.mutable(Schema.Array(RemediationPlaceholder))),
  }),
);

const IacRemediationHint = exact<IacRemediationHint>()(
  Schema.Struct({
    address: Schema.String,
    stateLabel: Schema.NullOr(Schema.String),
    attributeChanges: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          attribute: Schema.String,
          from: Schema.NullOr(Schema.String),
          to: Schema.NullOr(Schema.String),
        }),
      ),
    ),
    commands: Schema.mutable(Schema.Array(RemediationCommand)),
  }),
);

const FindingRemediation = exact<FindingRemediation>()(
  Schema.Struct({
    commands: Schema.mutable(Schema.Array(RemediationCommand)),
    placeholders: Schema.mutable(Schema.Array(RemediationPlaceholder)),
    iac: Schema.NullOr(IacRemediationHint),
  }),
);

const IdleMetricEvidence = exact<IdleMetricEvidence>()(
  Schema.Struct({
    metric: Schema.String,
    label: Schema.String,
    statistic: Schema.Literals(["sum", "max", "average", "min", "count"]),
    value: Schema.NullOr(Schema.Finite),
    unit: Schema.Literals(["count", "bytes", "percent", "days"]),
    threshold: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    comparison: Schema.optionalKey(Schema.Literals(["atMost", "atLeast"])),
  }),
);

const OrphanIdleDetail = exact<OrphanIdleDetail>()(
  Schema.Struct({
    ruleId: Schema.String,
    ruleKey: Schema.String,
    ruleLabel: Schema.String,
    action: Schema.Literals(["remove", "reconfigure", "stop"]),
    lookbackDays: Schema.Finite,
    evidence: Schema.mutable(Schema.Array(IdleMetricEvidence)),
    detectedAt: Schema.String,
    evaluatedAt: Schema.String,
    hasResource: Schema.Boolean,
  }),
);

const IdleSavingsEstimate = exact<IdleSavingsEstimate>()(
  Schema.Struct({
    monthlyAmount: Schema.Finite,
    currency: Schema.String,
    basis: Schema.Literal("list-price"),
    note: Schema.optionalKey(Schema.String),
  }),
);

const ResourceOwnerAnnotation = exact<ResourceOwnerAnnotation>()(
  Schema.Struct({
    userId: Schema.NullOr(Schema.String),
    displayName: Schema.String,
    isLabel: Schema.Boolean,
    ticketUrl: Schema.NullOr(Schema.String),
    purpose: Schema.NullOr(Schema.String),
  }),
);

const OrphanedResource = exact<OrphanedResource>()(
  Schema.Struct({
    id: Schema.String,
    pluginId: Schema.String,
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    displayName: Schema.String,
    externalId: Schema.NullOr(Schema.String),
    reason: Schema.String,
    cost: Schema.NullOr(Schema.Struct({ amount: Schema.Finite, currency: Schema.String })),
    owner: Schema.NullOr(ResourceOwnerAnnotation),
    lastSyncedAt: Schema.NullOr(Schema.String),
    remediation: Schema.optionalKey(FindingRemediation),
    idle: Schema.optionalKey(OrphanIdleDetail),
    estimate: Schema.optionalKey(Schema.NullOr(IdleSavingsEstimate)),
  }),
);

const OrphanAccountGroup = exact<OrphanAccountGroup>()(
  Schema.Struct({
    accountId: Schema.String,
    accountName: Schema.String,
    pluginId: Schema.String,
    pluginName: Schema.String,
    resources: Schema.mutable(Schema.Array(OrphanedResource)),
  }),
);

export const OrphanListResponse = exact<OrphanListResponseType>()(
  Schema.Struct({
    accounts: Schema.mutable(Schema.Array(OrphanAccountGroup)),
    totalCount: Schema.Int,
    unownedCount: Schema.Int,
    costWindowDays: Schema.Int,
    costBasis: Schema.optionalKey(Schema.Literals(["billing", "unavailable"])),
    generatedAt: Schema.String,
  }),
);

export class LocalOrphansRpcs extends RpcGroup.make(
  Rpc.make("LocalOrphansList", { success: OrphanListResponse, error: LocalWorkspaceError }),
) {}
