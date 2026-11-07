import type { ApiBody, ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { SupabaseResponse } from "./api.js";
import type { operations } from "./api-types.management.gen.js";
import type { paths as storagePaths } from "./api-types.storage.gen.js";

/** Wire shapes, from the Supabase Management API and Storage API documents. */

export type SbOrganization = ApiListItem<operations["v1-list-all-organizations"], null>;
export type SbMember = ApiListItem<operations["v1-list-organization-members"], null>;

/** `POST /v1/projects` answers without `database`; every other read has it. */
export type SbProject = SupabaseResponse<"v1-create-a-project"> & {
  database?: SupabaseResponse<"v1-get-project">["database"];
};

export type SbOrgProject = ApiListItem<
  operations["v1-get-all-projects-for-organization"],
  "projects"
>;
/** One database in `GET /v1/organizations/{slug}/projects` (primary or read replica). */
export type SbOrgProjectDatabase = SbOrgProject["databases"][number];

export type SbBranch = SupabaseResponse<"v1-create-a-branch">;
export type SbFunction =
  SupabaseResponse<"v1-get-a-function"> | SupabaseResponse<"v1-deploy-a-function">;
export type SbApiKey = SupabaseResponse<"v1-get-project-api-key">;
export type SbPooler = ApiListItem<operations["v1-get-pooler-config"], null>;
export type SbSsoProvider = SupabaseResponse<"v1-create-a-sso-provider">;
export type SbThirdPartyAuth = SupabaseResponse<"v1-create-project-tpa-integration">;
export type SbSigningKey = SupabaseResponse<"v1-create-project-signing-key">;
export type SbRegion = SupabaseResponse<"v1-get-available-regions">["all"]["specific"][number];

/** Attributes as `POST /config/disk` takes them; see the patch on `DiskRequestBody`. */
export type SbDiskAttributes = ApiBody<operations["v1-modify-database-disk"]>["attributes"];

export type SbNetworkRestrictions = SupabaseResponse<"v1-get-network-restrictions">;
export type SbAddons = SupabaseResponse<"v1-list-project-addons">;
/** Only `gp3` reports a throughput, which reads as absent on `io2`. */
export type SbDiskConfig = SupabaseResponse<"v1-get-database-disk"> & {
  attributes: { throughput_mibps?: number };
};
export type SbDiskUtil = SupabaseResponse<"v1-get-disk-utilization">;
export type SbDiskAutoscale = SupabaseResponse<"v1-get-project-disk-autoscale-config">;
export type SbReadonly = SupabaseResponse<"v1-get-readonly-mode-status">;
export type SbUpgradeEligibility = SupabaseResponse<"v1-get-postgres-upgrade-eligibility">;
export type SbCustomHostname = SupabaseResponse<"v1-get-hostname-config">;
export type SbVanity = SupabaseResponse<"v1-get-vanity-subdomain-config">;
export type SbLint = SupabaseResponse<"v1-get-security-advisors">["lints"][number];
/** Only some services report `info`, and only Auth's has a version. */
export type SbHealth = ApiListItem<operations["v1-get-services-health"], null> & {
  info?: { version?: string } | null;
};

/**
 * A bucket as the Storage API has it, which carries limits the Management API
 * omits; a row of the Management API's own list fits it too.
 */
export type SbStorageBucket = ApiResponse<storagePaths["/bucket/{bucketId}"]["get"]>;

export type SbStorageObject = ApiListItem<
  storagePaths["/object/list/{bucketName}"]["post"],
  null
> & {
  metadata?: { size?: number; mimetype?: string; lastModified?: string } | null;
};
