import { useCallback } from "react";
import { useGT } from "gt-react";
import type {
  EquivalenceCategory,
  MigrationCostBasis,
  MigrationTargetNote,
  MigrationUnmatchedReason,
  PriceCatalogArea,
} from "@infrawrench/client-core";

/** Translated category names. Each `gt` call takes a literal, so the extractor sees it. */
export function useCategoryLabel(): (category: EquivalenceCategory) => string {
  const gt = useGT();
  return useCallback(
    (category: EquivalenceCategory) => {
      switch (category) {
        case "vm":
          return gt("Virtual machine");
        case "kubernetes-cluster":
          return gt("Kubernetes cluster");
        case "kubernetes-node-pool":
          return gt("Kubernetes node pool");
        case "managed-postgres":
          return gt("Managed PostgreSQL");
        case "managed-mysql":
          return gt("Managed MySQL");
        case "managed-redis":
          return gt("Managed Redis");
        case "managed-mongodb":
          return gt("Managed MongoDB");
        case "object-storage":
          return gt("Object storage");
        case "block-volume":
          return gt("Block volume");
        case "file-storage":
          return gt("File storage");
        case "load-balancer":
          return gt("Load balancer");
        case "container-app":
          return gt("Container app");
        case "serverless-function":
          return gt("Serverless function");
        case "container-registry":
          return gt("Container registry");
        case "static-ip":
          return gt("Static IP");
        case "dns-zone":
          return gt("DNS zone");
      }
    },
    [gt],
  );
}

export function useNoteLabel(): (note: MigrationTargetNote) => string {
  const gt = useGT();
  return useCallback(
    (note: MigrationTargetNote) => {
      switch (note) {
        case "no-account":
          return gt("Connect an account on this provider to price it");
        case "source-size-unknown":
          return gt("Source size unknown");
        case "no-size-match":
          return gt("No size meets the source");
        case "no-price":
          return gt("No published price");
        case "catalog-unavailable":
          return gt("Price list unavailable, try again shortly");
      }
    },
    [gt],
  );
}

export function useUnmatchedLabel(): (reason: MigrationUnmatchedReason) => string {
  const gt = useGT();
  return useCallback(
    (reason: MigrationUnmatchedReason) =>
      reason === "no-category"
        ? gt("No cross-provider equivalent")
        : gt("The target has no equivalent type"),
    [gt],
  );
}

export function useBasisLabel(): (basis: MigrationCostBasis) => string {
  const gt = useGT();
  return useCallback(
    (basis: MigrationCostBasis) =>
      basis === "billed" ? gt("billed") : basis === "estimate" ? gt("estimate") : gt("list price"),
    [gt],
  );
}

export function useAreaLabel(): (area: PriceCatalogArea) => string {
  const gt = useGT();
  return useCallback(
    (area: PriceCatalogArea) => {
      switch (area) {
        case "north-america":
          return gt("North America");
        case "south-america":
          return gt("South America");
        case "europe":
          return gt("Europe");
        case "asia-pacific":
          return gt("Asia Pacific");
        case "middle-east":
          return gt("Middle East");
        case "africa":
          return gt("Africa");
        case "oceania":
          return gt("Oceania");
      }
    },
    [gt],
  );
}
