import type { NetworkFlowRateCard } from "@infrawrench/plugin-base";

/**
 * DigitalOcean's published transfer rates, per GB.
 *
 * Checked against https://docs.digitalocean.com/platform/billing/bandwidth/ on
 * the `asOf` date: inbound and private (VPC) traffic is free, and outbound
 * transfer beyond the team's pooled allowance is $0.01 **per GiB**, converted
 * here to per GB (10^9 bytes). A region is one datacenter, so there is no
 * cross-zone boundary to price.
 *
 * The pooled allowance (500 GiB to 6,000 GiB per Droplet, summed across the
 * team) is *not* deducted: it is consumed by every Droplet, load balancer and
 * cluster on the team, most of which a single cluster cannot see. A cluster
 * well inside its team's allowance is billed nothing for this traffic, which
 * is exactly the case a billed data-transfer source corrects for.
 */
export const DIGITALOCEAN_TRANSFER_RATES: NetworkFlowRateCard = {
  currency: "USD",
  asOf: "2026-10-04",
  perGb: {
    intra_zone: 0,
    cross_zone: 0,
    internet_egress: 0.01 / 1.073741824,
    internet_ingress: 0,
    provider_service: 0,
    unknown: 0,
  },
};
