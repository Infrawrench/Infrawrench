/**
 * Extended support: declarative "this resource runs a version the provider
 * charges extra to keep supporting (or is about to stop supporting)".
 *
 * Managed Kubernetes and managed databases are priced on the assumption that
 * you keep upgrading. Once a version leaves the provider's standard support
 * window, one of two things happens: the provider bills a surcharge for as
 * long as you stay on it (EKS extended support per cluster-hour, RDS Extended
 * Support per vCPU-hour, rising in year three), or it schedules a forced
 * upgrade. Both are knowable from the running version alone, and both are
 * silent until the bill or the maintenance window arrives.
 *
 * Plugins declare, per resource type, the provider's own support calendar
 * (which versions, when standard support ends, when extended support ends,
 * what the surcharge costs and what to upgrade to) over fields their listers
 * already sync. Hosts evaluate it over stored resources: no plugin client, no
 * credentials, no extra provider API calls; the same contract as
 * `orphanRule`, `expiryFields` and `postureChecks`. The workspace-wide
 * computation (`computeExtendedSupport`) lives in `@infrawrench/client-core`
 * because the mobile app, the CLI and the poller compute it too; that module
 * imports these types only.
 *
 * **The calendar is the plugin's, and it is data.** Providers publish these
 * dates and prices in prose and change them a few times a year, so every
 * figure here must come from the provider's current documentation, carry the
 * URL it came from (`pricingUrl`, `upgradeUrl`), and be revisited when a new
 * version enters the calendar. A release the plugin does not list is a
 * release that is never flagged: the safe direction, because a false
 * "you are paying a surcharge" is the claim a finance reader acts on.
 *
 * Billed amounts are a separate, optional, credentialed half:
 * `PluginClient.fetchExtendedSupportCharges` (manifest.ts) returns the
 * surcharge line items the provider actually billed, which the cloud host
 * prefers over the list-price computation wherever it can attribute them.
 */

/**
 * What one unit of an extended-support surcharge is. Hosts multiply the
 * tier's hourly `rate` by the resource's quantity (see
 * {@link ExtendedSupportDeclaration.quantityFieldKey}) and by 730 hours for a
 * monthly figure.
 */
export type ExtendedSupportUnit =
  "cluster-hour" | "vcpu-hour" | "vcore-hour" | "node-hour" | "instance-hour" | "acu-hour";

/** One price step of a surcharge. Providers raise the rate the longer you stay. */
export interface ExtendedSupportRateTier {
  /** First UTC day (`YYYY-MM-DD`) this rate applies. */
  from: string;
  /**
   * Price per unit-hour in the surcharge's currency. Omit when the provider
   * prices the tier relative to something the declaration cannot know (a
   * percentage of the node's own on-demand price, say); `label` then says how
   * it is priced and hosts render no computed figure rather than a wrong one.
   */
  rate?: number;
  /** Plugin-authored caption, e.g. "Years 1-2: $0.100 per vCPU-hour". */
  label: string;
}

/** How a paid extension is priced. */
export interface ExtendedSupportSurcharge {
  unit: ExtendedSupportUnit;
  /** ISO 4217 code the `rate`s are in. */
  currency: string;
  /** Ascending by `from`. The first tier normally starts on `standardSupportEnds`. */
  tiers: ExtendedSupportRateTier[];
  /** The provider page the rates were taken from. */
  pricingUrl: string;
  /**
   * Caveat on the computed figure, e.g. "US East (N. Virginia) list price;
   * other regions differ". Shown beside every computed (not billed) amount.
   */
  priceNote?: string;
}

/**
 * One entry of the provider's support calendar: a set of versions that share
 * an end-of-standard-support date.
 */
export interface ExtendedSupportRelease {
  /**
   * Stable id, unique within the resource type, e.g. `"k8s-1.29"`. Surfaces
   * key findings and filed issues on it, so renaming one orphans that context.
   */
  id: string;
  /** Product caption, e.g. "Amazon EKS" or "RDS for PostgreSQL". */
  product: string;
  /**
   * Engines this entry applies to, matched case-insensitively against the
   * declaration's `engineFieldKey`. Omit when the type has a single engine.
   */
  engines?: string[];
  /**
   * Version prefixes, matched case-insensitively against the start of the
   * stored version at a boundary: `"1.29"` matches `1.29`, `1.29.4` and
   * `v1.29.4-eks-1234`, never `1.290`; `"12"` matches `12.17`, never `120`.
   * A leading `v` on the stored value is ignored.
   */
  versions: string[];
  /** Last day of standard support (`YYYY-MM-DD`): the surcharge starts the day after. */
  standardSupportEnds: string;
  /**
   * Last day of extended support, after which the provider upgrades the
   * resource itself. Omit when the provider has not published one.
   */
  extendedSupportEnds?: string;
  /** The version to move to, e.g. "1.33" or "PostgreSQL 17". */
  targetVersion: string;
  /**
   * How staying is priced. Omit when the provider offers no paid extension:
   * leaving standard support then means a forced upgrade or an unsupported
   * resource, which is still a finding, just one with no surcharge.
   */
  surcharge?: ExtendedSupportSurcharge;
  /** Where the provider documents the upgrade path. */
  upgradeUrl: string;
  /** Optional plugin-authored caveat shown on the finding. */
  note?: string;
}

/**
 * A predicate on a stored field deciding whether the surcharge applies at
 * all, e.g. an EKS cluster whose upgrade policy is `STANDARD` is upgraded at
 * the end of standard support instead of being billed for extended support.
 *
 * - `in`: the field's value is one of these (case-insensitive). An absent
 *   field fails.
 * - `notIn`: the field's value is none of these. An absent field passes,
 *   which is what you want when the provider's default is to charge.
 */
export interface ExtendedSupportCondition {
  fieldKey: string;
  in?: string[];
  notIn?: string[];
}

/**
 * Declares that instances of this type run a versioned engine with a support
 * calendar. See the module documentation for the contract.
 */
export interface ExtendedSupportDeclaration {
  /** Field holding the running version, e.g. `"engineVersion"`. */
  versionFieldKey: string;
  /** Field holding the engine, when releases are engine-specific. */
  engineFieldKey?: string;
  /**
   * Field holding how many surcharge units the resource bills for (vCPUs,
   * vCores, nodes). Omit for a per-resource charge such as EKS's per
   * cluster-hour. A declared field that is absent, zero or unparseable on an
   * instance leaves the computed figure empty rather than guessing a size.
   */
  quantityFieldKey?: string;
  /** Field holding the provider region, used to attribute billed charges. */
  regionFieldKey?: string;
  /**
   * All must hold for the surcharge to apply. When any fails the resource is
   * reported as heading for (or past) a forced upgrade instead, with
   * `notChargedNote` as the explanation.
   */
  chargedWhen?: ExtendedSupportCondition[];
  /** Why a resource that fails `chargedWhen` is not billed, and what happens instead. */
  notChargedNote?: string;
  releases: ExtendedSupportRelease[];
}

/**
 * One billed surcharge line, as returned by
 * `PluginClient.fetchExtendedSupportCharges`: the provider's own record of
 * what it charged for extended support over the requested window.
 *
 * Billing data rarely names the resource, so a charge is attributed by
 * `resourceTypeId` + `region` (+ `engine` when the provider's line item names
 * one). The host gives a charge to the single matching finding when there is
 * exactly one, and apportions it across several by their list-price weight
 * otherwise, labelling the figure accordingly.
 */
export interface ExtendedSupportCharge {
  /**
   * The resource type the line item is for, e.g. `"eks-cluster"`. Omit when
   * the plugin cannot tell from the line item: the host then lists the charge
   * as unattributed rather than guessing.
   */
  resourceTypeId?: string;
  /**
   * The calendar entry (`ExtendedSupportRelease.id`) the line item names,
   * when it names a version: narrows attribution so a MySQL 5.7 line is not
   * shared with a MySQL 8.0 instance in the same region.
   */
  releaseId?: string;
  /** Provider region the charge accrued in, when the billing data says. */
  region?: string;
  /** Engine the line item names, matched against the declaration's `engineFieldKey`. */
  engine?: string;
  /** The provider's own line-item identifier, e.g. an AWS usage type. */
  lineItem: string;
  /** Total charged over the requested window, in `currency`. */
  amount: number;
  currency: string;
}
