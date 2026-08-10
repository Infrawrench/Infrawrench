/**
 * Reservation inventory via the tenant-level list:
 * `GET https://management.azure.com/providers/Microsoft.Capacity/reservations?api-version=2022-11-01`,
 * paginated by following `nextLink` (which carries the `$skiptoken`).
 *
 * Two Azure-specific facts shape the mapping:
 *
 * - **The list response contains no purchase price.** Money lives on the
 *   reservation *order*'s billing records, not here — so every money field is
 *   omitted. A substituted zero would render as "free reservation" in a
 *   finance review; "not reported" is the truthful answer.
 * - **Azure is the only provider that reports its own utilization** on the
 *   list response (`properties.utilization.aggregates[]` at 1/7/30-day
 *   grains). It is passed through verbatim as `providerUtilization` and never
 *   blended with anything the host derives from cost rows: the two are
 *   computed against different meters and averaging them produces a number
 *   checkable against neither.
 *
 * `termDays` comes from `properties.term` (P1Y/P3Y/P5Y). Never from the
 * dates: Azure splits and merges reservations on exchange, and a split
 * child's effective date no longer spans the term it inherited.
 */

import type {
  CommitmentProviderUtilization,
  CommitmentRecord,
  CommitmentState,
} from "@infrawrench/plugin-base";

/** Everything commitment collection needs from the client, and nothing more. */
export interface AzureCommitmentsContext {
  /** AAD-authenticated ARM GET, routed through host HTTP when available. */
  getJson<T>(url: string): Promise<T>;
}

const LIST_URL =
  "https://management.azure.com/providers/Microsoft.Capacity/reservations?api-version=2022-11-01";

interface AzureUtilizationAggregate {
  grain?: number;
  grainUnit?: string;
  value?: number;
  valueUnit?: string;
}

interface AzureReservationProperties {
  displayName?: string;
  provisioningState?: string;
  reservedResourceType?: string;
  quantity?: number;
  effectiveDateTime?: string;
  benefitStartTime?: string;
  expiryDateTime?: string;
  expiryDate?: string;
  purchaseDateTime?: string;
  term?: string;
  billingPlan?: string;
  appliedScopeType?: string;
  utilization?: { aggregates?: AzureUtilizationAggregate[] };
}

interface AzureReservation {
  id?: string;
  name?: string;
  location?: string;
  sku?: { name?: string };
  properties?: AzureReservationProperties;
}

interface AzureReservationListResponse {
  value?: AzureReservation[];
  nextLink?: string | null;
}

/**
 * Azure's provisioning-state zoo, folded to three answers. Succeeded is the
 * only state in which the discount is being applied. The Creating /
 * PendingBilling / ConfirmedBilling family is a purchase in flight. Split and
 * Merged mean this record was retired in favour of successor reservations —
 * counting both parent and children would double the holding — and every
 * failure/cancellation/unknown state is expired, understating rather than
 * overstating what the org owns.
 */
export function normalizeAzureProvisioningState(raw: string): CommitmentState {
  switch (raw) {
    case "Succeeded":
      return "active";
    case "Creating":
    case "Created":
    case "PendingResourceHold":
    case "ConfirmedResourceHold":
    case "PendingBilling":
    case "ConfirmedBilling":
      return "queued";
    default:
      // Cancelled, Expired, Failed, BillingFailed, Split, Merged, and
      // anything Azure adds later.
      return "expired";
  }
}

/** P1Y/P3Y/P5Y → 365/1095/1825 days. */
function termToDays(term: string | undefined): number | undefined {
  switch (term) {
    case "P1Y":
      return 365;
    case "P3Y":
      return 1095;
    case "P5Y":
      return 1825;
    default:
      return undefined;
  }
}

/** Pass through only day-grain percentage aggregates, verbatim. */
function utilization(
  aggregates: AzureUtilizationAggregate[] | undefined,
): CommitmentProviderUtilization[] {
  const out: CommitmentProviderUtilization[] = [];
  for (const aggregate of aggregates ?? []) {
    if (aggregate.grainUnit !== "days" || aggregate.valueUnit !== "percentage") continue;
    const grainDays = Number(aggregate.grain);
    const percentage = Number(aggregate.value);
    if (!Number.isFinite(grainDays) || !Number.isFinite(percentage)) continue;
    out.push({ grainDays, percentage });
  }
  return out;
}

export function mapAzureReservation(reservation: AzureReservation): CommitmentRecord | null {
  const id = reservation.id ?? "";
  if (!id) return null;
  const props = reservation.properties ?? {};
  const termDays = termToDays(props.term);
  const quantity = props.quantity;
  const sku = reservation.sku?.name ?? "";
  const parts = [
    props.displayName || "Azure reservation",
    quantity && sku ? `${quantity}× ${sku}` : sku,
    props.reservedResourceType ?? "",
  ].filter(Boolean);
  const aggregates = utilization(props.utilization?.aggregates);
  // benefitStartTime is when the discount started applying; effectiveDateTime
  // is when this *version* of the record became effective (it moves on split
  // or merge). Prefer the benefit start when Azure reports it.
  const startDate = props.benefitStartTime ?? props.effectiveDateTime ?? "";
  const endDate = props.expiryDateTime ?? props.expiryDate;
  return {
    id,
    kind: "reservation",
    description: parts.join(" — "),
    ...(props.appliedScopeType ? { scope: props.appliedScopeType } : {}),
    ...(reservation.location ? { region: reservation.location } : {}),
    startDate,
    ...(endDate ? { endDate } : {}),
    ...(termDays !== undefined ? { termDays } : {}),
    ...(props.billingPlan === "Monthly"
      ? { paymentOption: "monthly" as const }
      : props.billingPlan === "Upfront"
        ? { paymentOption: "all_upfront" as const }
        : {}),
    // No money fields: the list response carries none.
    state: normalizeAzureProvisioningState(props.provisioningState ?? ""),
    ...(aggregates.length > 0 ? { providerUtilization: aggregates } : {}),
  };
}

export async function fetchAzureCommitments(
  ctx: AzureCommitmentsContext,
): Promise<CommitmentRecord[]> {
  const records: CommitmentRecord[] = [];
  let url: string | null | undefined = LIST_URL;
  while (url) {
    const page: AzureReservationListResponse = await ctx.getJson<AzureReservationListResponse>(url);
    for (const reservation of page.value ?? []) {
      const record = mapAzureReservation(reservation);
      if (record) records.push(record);
    }
    url = page.nextLink;
  }
  return records;
}
