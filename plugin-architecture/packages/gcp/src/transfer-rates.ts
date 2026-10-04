import type { NetworkFlowRateCard } from "@infrawrench/plugin-base";

/**
 * GCP's published data-transfer list rates, North America, converted to the
 * per-GB (10^9 bytes) unit the host prices in.
 *
 * GCP publishes these **per GiB**, unlike AWS and Azure, so each number below
 * is the published per-GiB rate divided by 1.073741824. Leaving them per GiB
 * would over-state every figure by 7.4%. Checked against
 * https://cloud.google.com/vpc/network-pricing on the `asOf` date:
 *
 * - Same zone over internal IPs: free.
 * - Between zones in one region: $0.01/GiB.
 * - Between regions within North America: $0.02/GiB.
 * - Premium Tier internet egress, first 1 TiB: $0.12/GiB. The step down above
 *   1 TiB is not applied, so a large bill reads high; see
 *   `server-core/src/network-flow/pricing.ts` for why tiers are not modelled.
 *
 * Declared as `transferRates`, not `networkFlows`: this plugin does not collect
 * flows itself (see the network costs docs for why), but a Kubernetes cluster
 * on GKE moves bytes across GCP's boundaries and is priced from here.
 */
const PER_GIB_TO_PER_GB = 1 / 1.073741824;

export const GCP_TRANSFER_RATES: NetworkFlowRateCard = {
  currency: "USD",
  asOf: "2026-10-04",
  perGb: {
    intra_zone: 0,
    cross_zone: 0.01 * PER_GIB_TO_PER_GB,
    cross_region: 0.02 * PER_GIB_TO_PER_GB,
    internet_egress: 0.12 * PER_GIB_TO_PER_GB,
    internet_ingress: 0,
    provider_service: 0,
    unknown: 0,
  },
};
