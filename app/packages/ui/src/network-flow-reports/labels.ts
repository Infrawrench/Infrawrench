import { useGT } from "gt-react";
import {
  formatFlowBytes,
  formatMoney,
  splitNetworkFlowPairKey,
  NETWORK_FLOW_REPORT_OTHER_KEY,
  NETWORK_FLOW_REPORT_TRUNCATED_KEY,
  type NetworkFlowReportDirection,
  type NetworkFlowReportGranularity,
  type NetworkFlowReportGroupBy,
  type NetworkFlowReportMetric,
  type NetworkFlowReportNotice,
  type NetworkFlowScope,
} from "@infrawrench/client-core";

/** Endpoint refs plugins use for peers that are a class rather than a resource. */
const UNATTRIBUTED_REF = "infrawrench:unattributed";

/**
 * Translated labels for the network flow report vocabulary. Written as literal
 * `gt()` calls in switches (not a lookup over client-core's English maps) so
 * the extractor sees every string; the CLI prints the client-core maps.
 */
export function useNetworkFlowReportLabels() {
  const gt = useGT();

  const groupBy = (g: NetworkFlowReportGroupBy): string => {
    switch (g) {
      case "none":
        return gt("No grouping");
      case "pair":
        return gt("Flow pair");
      case "source":
        return gt("Source");
      case "destination":
        return gt("Destination");
      case "traffic_class":
        return gt("Traffic class");
      case "service":
        return gt("Peer service");
      case "zone_pair":
        return gt("Zone pair");
      case "region_pair":
        return gt("Region pair");
      case "account":
        return gt("Account");
      case "network":
        return gt("VPC / network");
    }
  };

  const granularity = (g: NetworkFlowReportGranularity): string => {
    switch (g) {
      case "daily":
        return gt("Daily");
      case "weekly":
        return gt("Weekly");
      case "monthly":
        return gt("Monthly");
    }
  };

  const metric = (m: NetworkFlowReportMetric): string => {
    switch (m) {
      case "cost":
        return gt("Estimated cost");
      case "bytes":
        return gt("Bytes");
      case "both":
        return gt("Bytes and estimated cost");
    }
  };

  const trafficClass = (s: NetworkFlowScope): string => {
    switch (s) {
      case "intra_zone":
        return gt("Same zone");
      case "cross_zone":
        return gt("Cross-zone (incl. intra-region peering)");
      case "cross_region":
        return gt("Cross-region");
      case "internet_egress":
        return gt("Internet egress");
      case "internet_ingress":
        return gt("Internet ingress");
      case "provider_service":
        return gt("Provider service");
      case "nat_gateway":
        return gt("NAT gateway");
      case "private_interconnect":
        return gt("Transit, VPN & interconnect");
      case "unknown":
        return gt("Unclassified");
    }
  };

  const direction = (d: NetworkFlowReportDirection): string =>
    d === "egress" ? gt("Egress") : gt("Ingress");

  /** An endpoint's display name, with the class tokens translated. */
  const endpoint = (ref: string, label: string): string => {
    if (ref === NETWORK_FLOW_REPORT_TRUNCATED_KEY) return gt("Flows outside the stored top pairs");
    if (ref === UNATTRIBUTED_REF) return gt("Unidentified peer");
    if (ref === "internet") return gt("Internet");
    return label || ref;
  };

  /** A group's display label: sentinels, classes and empty values translated, data as-is. */
  const group = (groupKey: string, label: string, by: NetworkFlowReportGroupBy): string => {
    if (groupKey === NETWORK_FLOW_REPORT_OTHER_KEY) return gt("Everything else");
    if (by === "none") return gt("All traffic");
    if (by === "traffic_class") return trafficClass(groupKey as NetworkFlowScope);
    if (by === "pair") {
      const [src, dst] = splitNetworkFlowPairKey(groupKey);
      if (src === NETWORK_FLOW_REPORT_TRUNCATED_KEY) return endpoint(src, "");
      const [a, b] = label.split(" → ");
      return `${endpoint(src, a ?? "")} → ${endpoint(dst, b ?? "")}`;
    }
    if (by === "zone_pair" || by === "region_pair") {
      const [a, b] = splitNetworkFlowPairKey(groupKey);
      return `${a || gt("Not set")} → ${b || gt("Not set")}`;
    }
    if (by === "source" || by === "destination") return endpoint(groupKey, label);
    if (groupKey === "") return gt("Not set");
    return label || groupKey;
  };

  const notice = (n: NetworkFlowReportNotice): string => {
    switch (n) {
      case "collection_disabled":
        return gt(
          "Flow collection is off for this organization, so nothing new is being recorded. An admin turns it on under Network.",
        );
      case "no_flow_accounts":
        return gt("None of the accounts you can see has a provider that reports network flows.");
      case "beyond_retention":
        return gt(
          "The window starts more than 90 days ago. Flows are kept for 90 days, so the earliest buckets are empty.",
        );
      case "sampled_sources":
        return gt(
          "Some figures come from a flow source that samples traffic. Those bytes are the provider's scaled-up estimate and are marked as sampled.",
        );
      case "recut_excluded":
        return gt(
          "Kubernetes cluster traffic is left out because it also crosses the node interfaces a cloud flow log counts. Filter to a cluster's account to report on it.",
        );
      case "unattributed_traffic":
        return gt(
          "Some bytes could not be tied to a workload at one end. They are counted in the totals and never spread across the named pairs.",
        );
      case "truncated_traffic":
        return gt(
          "Some days had more pairs than are stored. The remainder is counted as flows outside the stored top pairs.",
        );
      case "multiple_currencies":
        return gt("Rate cards in more than one currency are in scope, so totals are per currency.");
    }
  };

  return { groupBy, granularity, metric, trafficClass, direction, endpoint, group, notice };
}

/** One figure as text, by kind. */
export function formatNetworkFlowFigure(
  kind: "bytes" | "cost",
  value: number,
  currency: string,
): string {
  return kind === "bytes" ? formatFlowBytes(value) : formatMoney(value, currency);
}
