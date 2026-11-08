/**
 * Local-mode expiry radar: the cloud's `/expiring` computation over this
 * machine's SQLite workspace (see `electron/local-expiring.ts`).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  ExpiryItem,
  ExpiryListResponse as ExpiryListResponseType,
} from "@infrawrench/client-core";
import { exact } from "../exact";
import { LocalWorkspaceError } from "../errors";

const ExpirySeverity = Schema.Literals(["expired", "critical", "warning", "upcoming", "ok"]);

const ExpiryItem = exact<ExpiryItem>()(
  Schema.Struct({
    resourceId: Schema.String,
    pluginId: Schema.String,
    pluginName: Schema.String,
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    accountId: Schema.String,
    accountName: Schema.String,
    displayName: Schema.String,
    externalId: Schema.NullOr(Schema.String),
    fieldKey: Schema.String,
    kind: Schema.Literals([
      "tls-cert",
      "domain",
      "api-token",
      "access-key",
      "k8s-cert",
      "ssh-key",
      "secret-version",
      "lease",
      "extended-support",
      "other",
    ]),
    label: Schema.String,
    basis: Schema.Literals(["expiry", "age"]),
    dueAt: Schema.String,
    daysRemaining: Schema.Int,
    severity: ExpirySeverity,
    leaseAutoDelete: Schema.optionalKey(Schema.Boolean),
  }),
);

export const ExpiryListResponse = exact<ExpiryListResponseType>()(
  Schema.Struct({
    items: Schema.mutable(Schema.Array(ExpiryItem)),
    totalCount: Schema.Int,
    counts: Schema.Struct({
      expired: Schema.Int,
      critical: Schema.Int,
      warning: Schema.Int,
      upcoming: Schema.Int,
      ok: Schema.Int,
    }),
    leadDays: Schema.Int,
    generatedAt: Schema.String,
  }),
);

export class LocalExpiringRpcs extends RpcGroup.make(
  Rpc.make("LocalExpiringList", { success: ExpiryListResponse, error: LocalWorkspaceError }),
) {}
