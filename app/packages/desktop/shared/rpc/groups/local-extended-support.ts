/**
 * Local-mode extended-support findings: the cloud's declared support
 * calendars over this machine's SQLite workspace, list price only (see
 * `electron/local-extended-support.ts`). The answer never carries `billing`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  ExtendedSupportBillingStatus,
  ExtendedSupportFinding,
  ExtendedSupportListResponse as ExtendedSupportListResponseType,
  ExtendedSupportTotal,
  UnattributedExtendedSupportCharge,
} from "@infrawrench/client-core";
import { exact } from "../exact";
import { LocalWorkspaceError } from "../errors";

const ExtendedSupportStatus = Schema.Literals([
  "surcharged",
  "unsupported",
  "end-of-life",
  "upcoming",
]);

const ExtendedSupportFinding = exact<ExtendedSupportFinding>()(
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
    region: Schema.NullOr(Schema.String),
    releaseId: Schema.String,
    product: Schema.String,
    engine: Schema.NullOr(Schema.String),
    currentVersion: Schema.String,
    targetVersion: Schema.String,
    status: ExtendedSupportStatus,
    standardSupportEnds: Schema.String,
    surchargeStartsOn: Schema.String,
    daysUntilSurcharge: Schema.Int,
    extendedSupportEnds: Schema.NullOr(Schema.String),
    daysUntilForcedUpgrade: Schema.NullOr(Schema.Int),
    charged: Schema.Boolean,
    quantity: Schema.NullOr(Schema.Finite),
    unit: Schema.NullOr(
      Schema.Literals([
        "cluster-hour",
        "vcpu-hour",
        "vcore-hour",
        "node-hour",
        "instance-hour",
        "acu-hour",
      ]),
    ),
    currency: Schema.NullOr(Schema.String),
    tierLabel: Schema.NullOr(Schema.String),
    monthlySurcharge: Schema.NullOr(Schema.Finite),
    listMonthlySurcharge: Schema.NullOr(Schema.Finite),
    costBasis: Schema.Literals(["billed", "billed-share", "list-price", "unpriced"]),
    billedLineItems: Schema.mutable(Schema.Array(Schema.String)),
    nextTier: Schema.NullOr(
      Schema.Struct({
        from: Schema.String,
        label: Schema.String,
        monthlySurcharge: Schema.NullOr(Schema.Finite),
      }),
    ),
    priceNote: Schema.NullOr(Schema.String),
    pricingUrl: Schema.NullOr(Schema.String),
    upgradeUrl: Schema.String,
    note: Schema.NullOr(Schema.String),
  }),
);

const ExtendedSupportTotal = exact<ExtendedSupportTotal>()(
  Schema.Struct({ currency: Schema.String, monthly: Schema.Finite }),
);

const BillingAccountStatus = exact<ExtendedSupportBillingStatus["accounts"][number]>()(
  Schema.Struct({
    accountId: Schema.String,
    accountName: Schema.String,
    status: Schema.Literals(["read", "failed"]),
    error: Schema.optionalKey(Schema.String),
  }),
);

const UnattributedExtendedSupportCharge = exact<UnattributedExtendedSupportCharge>()(
  Schema.Struct({
    resourceTypeId: Schema.optionalKey(Schema.String),
    releaseId: Schema.optionalKey(Schema.String),
    region: Schema.optionalKey(Schema.String),
    engine: Schema.optionalKey(Schema.String),
    lineItem: Schema.String,
    amount: Schema.Finite,
    currency: Schema.String,
    accountId: Schema.String,
    accountName: Schema.String,
    monthlyAmount: Schema.Finite,
  }),
);

/**
 * Never present in a local answer, but part of the contract type, so it is
 * part of the schema: leaving it out would let the encoder drop it silently.
 */
const ExtendedSupportBillingStatus = exact<ExtendedSupportBillingStatus>()(
  Schema.Struct({
    windowDays: Schema.Int,
    accounts: Schema.mutable(Schema.Array(BillingAccountStatus)),
    unattributed: Schema.mutable(Schema.Array(UnattributedExtendedSupportCharge)),
  }),
);

export const ExtendedSupportListResponse = exact<ExtendedSupportListResponseType>()(
  Schema.Struct({
    findings: Schema.mutable(Schema.Array(ExtendedSupportFinding)),
    totalCount: Schema.Int,
    counts: Schema.Struct({
      surcharged: Schema.Int,
      unsupported: Schema.Int,
      "end-of-life": Schema.Int,
      upcoming: Schema.Int,
    }),
    currentMonthly: Schema.mutable(Schema.Array(ExtendedSupportTotal)),
    upcomingMonthly: Schema.mutable(Schema.Array(ExtendedSupportTotal)),
    leadDays: Schema.Int,
    billing: Schema.optionalKey(ExtendedSupportBillingStatus),
    generatedAt: Schema.String,
  }),
);

export class LocalExtendedSupportRpcs extends RpcGroup.make(
  Rpc.make("LocalExtendedSupportList", {
    success: ExtendedSupportListResponse,
    error: LocalWorkspaceError,
  }),
) {}
