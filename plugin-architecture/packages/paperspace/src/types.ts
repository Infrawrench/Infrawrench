import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";

/** Paperspace API payloads this plugin reads, named from the OpenAPI document. */

export type PMachine = ApiResponse<operations["machines-get"]>;
export type PMachineEvent = ApiResponse<operations["machineEvents-get"]>;
export type POsTemplate = ApiListItem<operations["osTemplates-list"], "items">;
export type PCustomTemplate = ApiResponse<operations["customTemplates-get"]>;
export type PSharedDrive = ApiResponse<operations["sharedDrives-get"]>;
/** The document lists no creation time on a snapshot; the plugin reads one if it is sent. */
export type PSnapshot = ApiResponse<operations["snapshots-get"]> & { dtCreated?: string };
/** The document marks the answer to a get nullable; a null is handled where it is read. */
export type PNetwork = NonNullable<ApiResponse<operations["privateNetworks-get"]>>;
export type PPublicIp = ApiListItem<operations["publicIps-list"], "items">;
export type PStartupScript = ApiResponse<operations["startupScripts-get"]>;
export type PProject = ApiResponse<operations["projects-get"]>;
export type PDeployment = ApiResponse<operations["deployments-get"]>;
export type PRegistry = ApiResponse<operations["containerRegistries-get"]>;

/** What the mapper reads of a deployment's spec, across the document's spec versions. */
export interface PDeploymentSpec {
  apiVersion?: string;
  image?: string;
  enabled?: boolean;
  region?: string;
  port?: number;
  resources?: {
    machineType?: string;
    instanceType?: string;
    replicas?: number;
    ports?: number[];
  };
}
