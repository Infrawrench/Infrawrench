import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { components, operations } from "./api-types.gen.js";

/**
 * The Vast.ai payloads this plugin reads, from the published OpenAPI document.
 * What is added here is what Vast sends and the document leaves out. Everything
 * is optional: the document marks almost nothing required and Vast omits nulls
 * freely.
 */

type Schemas = components["schemas"];

/** The list row and the single instance differ, most of all in `ports`. */
export type VInstance = (
  ApiListItem<operations["showInstances"], "instances"> | Schemas["Instance"]
) & {
  cuda_max_good?: number | null;
  volume_info?: Array<{ volume_id?: number; mount_path?: string }> | null;
};

/** The document says an offer is an object and lists nothing in it. */
export type VOffer = ApiListItem<operations["searchOffers"], "offers"> & {
  id?: number;
  gpu_name?: string;
  num_gpus?: number;
  cpu_cores_effective?: number;
  cpu_ram?: number;
  disk_space?: number;
  dph_total?: number;
  min_bid?: number;
  reliability?: number;
  reliability2?: number;
  geolocation?: string;
};

export type VVolume = Schemas["Volume"] & {
  label?: string | null;
  geolocation?: string | null;
};

export type VVolumeOffer = Schemas["VolumeOffer"];

export type VTemplate = Schemas["Template"] & {
  hash_id?: string;
  tag?: string;
  /** The document's filter list names this column beside `tag`. */
  default_tag?: string;
  desc?: string;
  env?: string;
  onstart?: string;
  runtype?: string;
  ssh_direct?: boolean;
  use_ssh?: boolean;
  jup_direct?: boolean;
  jupyter_dir?: string;
  use_jupyter_lab?: boolean;
  docker_login_repo?: string;
  docker_login_user?: string;
  docker_login_pass?: string;
  extra_filters?: Record<string, unknown>;
  recommended_disk_space?: number;
  readme?: string;
  readme_visible?: boolean;
  args_str?: string;
  href?: string;
  repo?: string;
  private?: boolean;
  volume_info?: Record<string, unknown> | null;
  /** Set by this plugin on the ones Vast recommends. */
  recommended?: boolean;
  count_created?: number;
};

/** The list says `key`, a created key says `public_key`. */
export type VSshKey = ApiListItem<operations["getSshKeysUser"], null> & { public_key?: string };

export type VEndpoint = ApiListItem<operations["showEndpoints"], "results">;

export type VWorkergroup = ApiListItem<operations["showWorkergroup"], "results">;

export type VUser = ApiResponse<operations["showUser"]> & { credit?: number };

export type VChargeEntry = ApiListItem<operations["showCharges"], "results">;
