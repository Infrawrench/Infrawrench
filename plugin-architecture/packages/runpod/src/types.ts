import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";

/**
 * REST payloads come from the published OpenAPI document
 * (`https://rest.runpod.io/v1/openapi.json`, see `plugingen.json`). GraphQL has
 * no document the generator can read, so those are the slice this plugin reads,
 * with names from the public schema reference (`https://graphql-spec.runpod.io`,
 * checked 2026-10) and everything optional.
 */

/** `imageName` and `networkVolumeId` are read as fallbacks; the document lists neither on a pod. */
export type RpPod = ApiResponse<operations["GetPod"]> & {
  imageName?: string;
  networkVolumeId?: string;
};

/** The document lists `flashboot` as an input only. */
export type RpEndpoint = ApiResponse<operations["GetEndpoint"]> & { flashboot?: boolean };

export type RpTemplate = ApiResponse<operations["GetTemplate"]>;
export type RpNetworkVolume = ApiResponse<operations["CreateNetworkVolume"]>;
export type RpRegistryAuth = ApiResponse<operations["CreateContainerRegistryAuth"]>;
export type RpBillingRecord = ApiListItem<operations["PodBilling"], null>;
export type RpVolumeBillingRecord = ApiListItem<operations["NetworkVolumeBilling"], null>;

export interface RpSavingsPlan {
  id?: string;
  costPerHr?: number;
  startTime?: string;
  endTime?: string;
  gpuTypeId?: string;
  podId?: string;
}

/** GraphQL extras merged into each pod: runtime telemetry and the SSH proxy host id. */
export interface RpPodExtras {
  id: string;
  createdAt?: string;
  machine?: { podHostId?: string; dataCenterId?: string; secureCloud?: boolean };
  runtime?: {
    uptimeInSeconds?: number;
    container?: { cpuPercent?: number; memoryPercent?: number };
    gpus?: Array<{ id?: string; gpuUtilPercent?: number; memoryUtilPercent?: number }>;
  } | null;
}

export interface RpEndpointHealth {
  jobs?: {
    completed?: number;
    failed?: number;
    inProgress?: number;
    inQueue?: number;
    retried?: number;
  };
  workers?: {
    idle?: number;
    running?: number;
    initializing?: number;
    ready?: number;
    throttled?: number;
    unhealthy?: number;
  };
}

export interface RpGpuType {
  id: string;
  displayName?: string;
  memoryInGb?: number;
  manufacturer?: string;
  secureCloud?: boolean;
  communityCloud?: boolean;
  securePrice?: number | null;
  communityPrice?: number | null;
  secureSpotPrice?: number | null;
  communitySpotPrice?: number | null;
  maxGpuCount?: number | null;
  lowestPrice?: {
    stockStatus?: string | null;
    uninterruptablePrice?: number | null;
    minimumBidPrice?: number | null;
  } | null;
}

export interface RpDataCenter {
  id: string;
  name?: string;
  location?: string;
  storageSupport?: boolean;
  listed?: boolean;
  gpuAvailability?: Array<{ gpuTypeId?: string; available?: boolean; stockStatus?: string | null }>;
}

export interface RpMyself {
  id?: string;
  email?: string;
  clientBalance?: number | null;
  currentSpendPerHr?: number | null;
  spendLimit?: number | null;
  maxServerlessConcurrency?: number | null;
  underBalance?: boolean | null;
  pubKey?: string | null;
  savingsPlans?: Array<
    RpSavingsPlan & {
      upfrontCost?: number | null;
      planLength?: string | null;
      savingsPlanType?: string | null;
    }
  > | null;
}
