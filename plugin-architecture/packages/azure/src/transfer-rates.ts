import type { NetworkFlowRateCard } from "@infrawrench/plugin-base";

/**
 * Azure's published bandwidth list rates, North America and Europe, per GB.
 * Checked against https://azure.microsoft.com/en-us/pricing/details/bandwidth/
 * on the `asOf` date:
 *
 * - Within an availability zone, and **between** availability zones: free.
 *   Azure stopped charging for inter-zone transfer in May 2024
 *   (https://azure.microsoft.com/updates/update-on-interavailability-zone-data-transfer-pricing),
 *   which is why `cross_zone` is 0 here while it is $0.01 on AWS and GCP.
 * - Between regions within North America or Europe: $0.02/GB.
 * - Internet egress over Microsoft's premium network, first paid tier:
 *   $0.087/GB. The 100 GB/month free allowance and the lower tiers are not
 *   applied; see `server-core/src/network-flow/pricing.ts`.
 *
 * Declared as `transferRates`: Azure flow logs are not collected (see the
 * network costs docs), but an AKS cluster's traffic is priced from here.
 */
export const AZURE_TRANSFER_RATES: NetworkFlowRateCard = {
  currency: "USD",
  asOf: "2026-10-04",
  perGb: {
    intra_zone: 0,
    cross_zone: 0,
    cross_region: 0.02,
    internet_egress: 0.087,
    internet_ingress: 0,
    provider_service: 0,
    unknown: 0,
  },
};
