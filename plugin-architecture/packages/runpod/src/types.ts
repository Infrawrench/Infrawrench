import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";

/**
 * REST payloads come from the published OpenAPI document
 * (`https://api.runpod.io/v2/openapi.json`, see `plugingen.json`). GraphQL has
 * no document the generator can read, so those are the slice this plugin reads,
 * with names from the public schema reference (`https://graphql-spec.runpod.io`,
 * checked 2026-11) and everything optional.
 */

export type RpPod = ApiResponse<operations["getPod"]>;
export type RpEndpoint = ApiResponse<operations["getEndpoint"]>;
export type RpTemplate = ApiResponse<operations["getTemplate"]>;
export type RpNetworkVolume = ApiResponse<operations["getNetworkVolume"]>;
export type RpRegistryAuth = ApiResponse<operations["createRegistry"]>;
export type RpPodBillingRecord = ApiListItem<operations["listPodBilling"], "records">;
export type RpServerlessBillingRecord = ApiListItem<operations["listServerlessBilling"], "records">;
export type RpVolumeBillingRecord = ApiListItem<operations["listNetworkVolumeBilling"], "records">;
export type RpGpuType = ApiListItem<operations["listGpuTypes"], "gpus">;
export type RpCpuType = ApiListItem<operations["listCpuTypes"], "cpus">;
export type RpDataCenter = ApiListItem<operations["listDataCenters"], "dataCenters">;

/** What only GraphQL reports about a pod. REST lists carry no runtime at all. */
export interface RpPodExtras {
  id: string;
  adjustedCostPerHr?: number | null;
  lastStatusChange?: string | null;
  machine?: {
    location?: string | null;
    gpuDisplayName?: string | null;
    maintenanceStart?: string | null;
    maintenanceEnd?: string | null;
    maintenanceNote?: string | null;
  } | null;
  runtime?: {
    uptimeInSeconds?: number;
    container?: { cpuPercent?: number; memoryPercent?: number };
    gpus?: Array<{ id?: string; gpuUtilPercent?: number; memoryUtilPercent?: number }>;
    ports?: Array<{
      ip?: string | null;
      isIpPublic?: boolean | null;
      privatePort?: number | null;
      publicPort?: number | null;
      type?: string | null;
    }>;
  } | null;
}

/** What only GraphQL reports about a template. */
export interface RpTemplateExtras {
  id: string;
  readme?: string | null;
  earned?: number | null;
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

export interface RpSavingsPlan {
  id?: string;
  costPerHr?: number;
  startTime?: string;
  endTime?: string;
  gpuTypeId?: string;
  podId?: string;
}

export interface RpMyself {
  id?: string;
  email?: string;
  clientBalance?: number | null;
  currentSpendPerHr?: number | null;
  spendLimit?: number | null;
  maxServerlessConcurrency?: number | null;
  underBalance?: boolean | null;
  savingsPlans?: Array<
    RpSavingsPlan & {
      upfrontCost?: number | null;
      planLength?: string | null;
      savingsPlanType?: string | null;
    }
  > | null;
}
