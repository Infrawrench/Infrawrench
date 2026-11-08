/**
 * Local-mode DNS inventory: the cloud's `/dns` computation over this
 * machine's SQLite workspace (see `electron/local-dns.ts`).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  DnsInventoryResponse as DnsInventoryResponseType,
  DnsRecordEntry,
  DnsRecordTarget,
  DnsSkippedNamespace,
  DnsTargetResource,
  DnsTargetService,
  DnsZoneEntry,
} from "@infrawrench/client-core";
import { exact } from "../exact";
import { LocalWorkspaceError } from "../errors";

export const PostureSeverity = Schema.Literals(["critical", "high", "medium", "low"]);

const DnsTargetClassification = Schema.Literals(["owned", "dangling", "external", "not-analysed"]);

const DnsTargetResource = exact<DnsTargetResource>()(
  Schema.Struct({
    resourceId: Schema.String,
    displayName: Schema.String,
    pluginId: Schema.String,
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    accountId: Schema.String,
  }),
);

const DnsTargetService = exact<DnsTargetService>()(
  Schema.Struct({
    pluginId: Schema.String,
    pluginName: Schema.String,
    resourceTypeId: Schema.String,
    ruleId: Schema.String,
    label: Schema.String,
    severity: PostureSeverity,
    reason: Schema.String,
    claimLabel: Schema.String,
  }),
);

const DnsRecordTarget = exact<DnsRecordTarget>()(
  Schema.Struct({
    value: Schema.String,
    classification: DnsTargetClassification,
    resource: Schema.NullOr(DnsTargetResource),
    service: Schema.NullOr(DnsTargetService),
  }),
);

const DnsRecordEntry = exact<DnsRecordEntry>()(
  Schema.Struct({
    resourceId: Schema.String,
    pluginId: Schema.String,
    pluginName: Schema.String,
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    accountId: Schema.String,
    accountName: Schema.String,
    zoneResourceId: Schema.NullOr(Schema.String),
    zoneDomain: Schema.NullOr(Schema.String),
    name: Schema.String,
    type: Schema.String,
    ttl: Schema.NullOr(Schema.Finite),
    priority: Schema.NullOr(Schema.Finite),
    proxied: Schema.Boolean,
    targets: Schema.mutable(Schema.Array(DnsRecordTarget)),
    status: DnsTargetClassification,
  }),
);

const DnsZoneEntry = exact<DnsZoneEntry>()(
  Schema.Struct({
    resourceId: Schema.String,
    pluginId: Schema.String,
    pluginName: Schema.String,
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    accountId: Schema.String,
    accountName: Schema.String,
    domain: Schema.String,
    status: Schema.NullOr(Schema.String),
    isPrivate: Schema.Boolean,
    recordCount: Schema.Int,
    providerRecordCount: Schema.NullOr(Schema.Int),
    danglingCount: Schema.Int,
  }),
);

const DnsSkippedNamespace = exact<DnsSkippedNamespace>()(
  Schema.Struct({
    pluginId: Schema.String,
    pluginName: Schema.String,
    label: Schema.String,
    reason: Schema.String,
  }),
);

export const DnsInventoryResponse = exact<DnsInventoryResponseType>()(
  Schema.Struct({
    zones: Schema.mutable(Schema.Array(DnsZoneEntry)),
    records: Schema.mutable(Schema.Array(DnsRecordEntry)),
    counts: Schema.Struct({
      zones: Schema.Int,
      records: Schema.Int,
      owned: Schema.Int,
      dangling: Schema.Int,
      external: Schema.Int,
      notAnalysed: Schema.Int,
    }),
    skippedNamespaces: Schema.mutable(Schema.Array(DnsSkippedNamespace)),
    generatedAt: Schema.String,
  }),
);

export class LocalDnsRpcs extends RpcGroup.make(
  Rpc.make("LocalDnsInventory", { success: DnsInventoryResponse, error: LocalWorkspaceError }),
) {}
