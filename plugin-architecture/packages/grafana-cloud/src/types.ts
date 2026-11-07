/**
 * Response shapes this plugin reads, from each provider document named in
 * `plugingen.json`: Grafana's Cloud API (`grafana.com/api/openapi.json`), the
 * stack-level Grafana HTTP API, and Synthetic Monitoring (`/api/v1/openapi`).
 */

import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { operations as CloudOperations } from "./api-types.cloud.gen.js";
import type { operations as SmOperations } from "./api-types.sm.gen.js";
import type { operations as StackOperations } from "./api-types.stack.gen.js";

/**
 * `GET /api/orgs/{slugOrId}`. Partial because a token without `orgs:read` still
 * works from a typed slug, and all that is known then is that slug.
 */
export type GcOrg = Partial<ApiResponse<CloudOperations["getOrg"]>>;

/** `GET /api/orgs/{orgSlug}/instances` items (FormattedApiInstance). */
export type GcStack = ApiResponse<CloudOperations["getInstance"]>;

/** `GET /api/stack-regions` items. */
export type GcRegion = ApiListItem<CloudOperations["getStackRegions"], "items">;

/** `GET /api/instances/{id}/plugins` items. */
export type GcStackPlugin = ApiListItem<CloudOperations["getInstancePlugins"], "items">;

/** `GET /api/v1/accesspolicies` items (AuthAccessPolicy). */
export type GcAccessPolicy = ApiListItem<CloudOperations["getAccessPolicies"], "items">;

/** `GET /api/v1/tokens` items (AuthToken). */
export type GcToken = ApiListItem<CloudOperations["getTokens"], "items">;

/** `/api/v1/accesspolicies` and `/api/v1/tokens` page envelope. */
export interface GcCursorPage<T> {
  items?: T[];
  metadata?: { pagination?: { nextPage?: string | null } };
}

/** `GET /api/orgs/{slug}/members` items (FormattedOrgMembership). */
export type GcMember = ApiListItem<CloudOperations["getOrgMembers"], "items">;

type BilledUsageItem = ApiListItem<CloudOperations["getOrgBilledUsage"], "items">;

/**
 * `GET /api/orgs/{slugOrId}/billed-usage` items (BilledUsage). A billing row
 * missing a field must still cost out, so everything is read as optional.
 */
export type GcBilledUsage = Partial<Omit<BilledUsageItem, "usages">> & {
  usages?: Array<Partial<BilledUsageItem["usages"][number]>>;
};

// ---------------------------------------------------------------------------
// Stack Grafana HTTP API
// ---------------------------------------------------------------------------

/** `GET /api/search?type=dash-db`. */
export type GfDashboardHit = ApiListItem<StackOperations["search"], null>;

/** `GET /api/v1/provisioning/alert-rules`. */
export type GfAlertRule = ApiListItem<StackOperations["RouteGetAlertRules"], null>;

/** `GET /api/v1/provisioning/contact-points`. */
export type GfContactPoint = ApiListItem<StackOperations["RouteGetContactpoints"], null>;

/** `GET /api/datasources`. */
export type GfDatasource = ApiListItem<StackOperations["getDataSources"], null>;

/** `GET /api/folders`. */
export type GfFolder = ApiListItem<StackOperations["getFolders"], null>;

// ---------------------------------------------------------------------------
// Synthetic Monitoring API
// ---------------------------------------------------------------------------

export type SmCheck = ApiListItem<SmOperations["GET_/api/v1/check"], null>;

export type SmProbe = ApiListItem<SmOperations["GET_/api/v1/probe"], null>;
