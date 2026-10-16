import { useMemo } from "react";
import { useGT } from "gt-react";
import type {
  K8sCostCategory,
  K8sEfficiencyGranularity,
  K8sEfficiencyGroupBy,
  K8sUsageState,
  KubernetesEfficiencyRowKind,
} from "@infrawrench/client-core";

/**
 * Translated labels for the efficiency report vocabulary. Spelled out per
 * value rather than looked up from client-core's English maps, so every
 * string is a literal the translation extractor can see.
 */
export function useK8sEfficiencyLabels() {
  const gt = useGT();
  return useMemo(
    () => ({
      category(c: K8sCostCategory): string {
        switch (c) {
          case "cpu":
            return gt("CPU");
          case "memory":
            return gt("Memory");
          case "gpu":
            return gt("GPU");
          case "storage":
            return gt("Storage");
          case "network":
            return gt("Network");
          case "control_plane":
            return gt("Control plane");
          case "compute":
            return gt("CPU and memory (combined)");
        }
      },
      state(s: K8sUsageState): string {
        switch (s) {
          case "used":
            return gt("Used");
          case "unused":
            return gt("Requested, unused");
          case "unmeasured":
            return gt("Unmeasured");
          case "idle":
            return gt("Idle");
          case "overhead":
            return gt("Overhead");
        }
      },
      groupBy(g: K8sEfficiencyGroupBy): string {
        switch (g) {
          case "cluster":
            return gt("Cluster");
          case "namespace":
            return gt("Namespace");
          case "workload":
            return gt("Workload");
          case "label":
            return gt("Label");
          case "node_pool":
            return gt("Node pool");
          case "category":
            return gt("Cost category");
        }
      },
      granularity(g: K8sEfficiencyGranularity): string {
        switch (g) {
          case "day":
            return gt("Daily");
          case "week":
            return gt("Weekly");
          case "month":
            return gt("Monthly");
        }
      },
      rowKind(kind: KubernetesEfficiencyRowKind): string | null {
        switch (kind) {
          case "idle":
            return gt("Idle capacity");
          case "overhead":
            return gt("Cluster overhead");
          case "unattributed":
            return gt("(no value)");
          case "group":
            return null;
        }
      },
    }),
    [gt],
  );
}
