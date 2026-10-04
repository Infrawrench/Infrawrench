/**
 * Response shapes this plugin reads, trimmed to the fields it uses. Cloud API
 * shapes are verified against Grafana's published Cloud API OpenAPI document
 * (`grafana/grafana-com-public-clients`, `openapi.json`, 2026-10); stack
 * shapes against the Grafana HTTP API reference; Synthetic Monitoring shapes
 * against its OpenAPI document (`/api/v1/openapi`, version 1.18.0).
 */

/** `GET /api/orgs/{slugOrId}` (FormattedApiOrgPublic). */
export interface GcOrg {
  id?: number;
  slug?: string;
  name?: string;
  url?: string;
  createdAt?: string;
  gcloudMonthlyCost?: number;
  contractType?: string;
  trialEndDate?: string | null;
  subscriptions?: {
    current?: {
      product?: string | null;
      plan?: string | null;
      publicName?: string | null;
      isTrial?: boolean;
      startDate?: string | null;
      endDate?: string | null;
    };
  };
  hgUsage?: number;
  hmUsage?: number;
  hmCurrentUsage?: number;
  hlUsage?: number;
  htUsage?: number;
  hpUsage?: number;
  irmUsage?: number;
  k6VuhUsage?: number;
  feO11YUsage?: number;
  appO11YUsage?: number;
  smUsage?: number;
  infraO11YHostsUsage?: number;
}

/** `GET /api/orgs/{orgSlug}/instances` items (FormattedApiInstance). */
export interface GcStack {
  id?: number;
  orgId?: number;
  orgSlug?: string;
  slug?: string;
  name?: string;
  url?: string;
  description?: string;
  labels?: Record<string, string> | null;
  status?: string;
  plan?: string;
  planName?: string;
  version?: string;
  runningVersion?: string;
  regionSlug?: string;
  regionPublicName?: string;
  provider?: string;
  providerRegion?: string;
  clusterSlug?: string;
  deleteProtection?: boolean;
  createdAt?: string;
  updatedAt?: string;
  trial?: number | boolean;
  trialExpiresAt?: string | null;
  dashboardCnt?: number;
  alertCnt?: number;
  currentActiveUsers?: number;
  billingActiveUsers?: number;
  hmInstancePromId?: number;
  hmInstancePromUrl?: string;
  hmInstancePromCurrentActiveSeries?: number;
  hmInstancePromCurrentUsage?: number;
  hlInstanceId?: number;
  hlInstanceUrl?: string;
  hlInstanceCurrentUsage?: number;
  htInstanceId?: number;
  htInstanceUrl?: string;
  htInstanceCurrentUsage?: number;
  hpInstanceId?: number;
  hpInstanceUrl?: string;
  hpInstanceCurrentUsage?: number;
  amInstanceUrl?: string;
  regionSyntheticMonitoringApiUrl?: string;
}

/** `GET /api/stack-regions` items. */
export interface GcRegion {
  id?: number;
  slug?: string;
  name?: string;
  publicName?: string;
  description?: string;
  provider?: string;
  status?: string;
  visibility?: string;
}

/** `GET /api/instances/{id}/plugins` items. */
export interface GcStackPlugin {
  id?: number;
  instanceId?: number;
  instanceSlug?: string;
  pluginId?: number;
  pluginSlug?: string;
  pluginName?: string;
  version?: string;
  latestVersion?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /api/v1/accesspolicies` items (AuthAccessPolicy). */
export interface GcAccessPolicy {
  id?: string;
  orgId?: string;
  name?: string;
  displayName?: string;
  scopes?: string[];
  realms?: Array<{
    type?: string;
    identifier?: string;
    labelPolicies?: Array<{ selector?: string }>;
  }>;
  conditions?: { allowedSubnets?: string[] } | null;
  attributes?: unknown;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /api/v1/tokens` items (AuthToken). */
export interface GcToken {
  id?: string;
  accessPolicyId?: string;
  name?: string;
  displayName?: string;
  expiresAt?: string | null;
  firstUsedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** `/api/v1/accesspolicies` and `/api/v1/tokens` page envelope. */
export interface GcCursorPage<T> {
  items?: T[];
  metadata?: { pagination?: { pageSize?: number; pageCursor?: string; nextPage?: string | null } };
}

/** `GET /api/orgs/{slug}/members` items (FormattedOrgMembership). */
export interface GcMember {
  id?: number;
  userId?: number;
  role?: string;
  userName?: string;
  userUsername?: string;
  userEmail?: string;
  mfaEnabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /api/orgs/{slugOrId}/billed-usage` items (BilledUsage). */
export interface GcBilledUsage {
  id?: number;
  dimensionId?: string;
  dimensionName?: string;
  unit?: string;
  includedUsage?: number;
  totalUsage?: number;
  overage?: number;
  amountDue?: number;
  periodStart?: string;
  periodEnd?: string;
  description?: string;
  usages?: GcBilledUsageStack[];
}

export interface GcBilledUsageStack {
  stackId?: number;
  stackName?: string;
  totalUsage?: number;
  attributedCost?: number;
  attributedUsage?: number;
  isProrated?: boolean;
  credits?: Array<{ amount?: number; dimensionId?: string; dimensionName?: string }>;
}

// ---------------------------------------------------------------------------
// Stack Grafana HTTP API
// ---------------------------------------------------------------------------

/** `GET /api/search?type=dash-db`. */
export interface GfDashboardHit {
  id?: number;
  uid?: string;
  title?: string;
  url?: string;
  type?: string;
  tags?: string[];
  isStarred?: boolean;
  folderUid?: string;
  folderTitle?: string;
}

/** `GET /api/v1/provisioning/alert-rules`. */
export interface GfAlertRule {
  id?: number;
  uid?: string;
  title?: string;
  folderUID?: string;
  ruleGroup?: string;
  condition?: string;
  noDataState?: string;
  execErrState?: string;
  for?: string;
  labels?: Record<string, string> | null;
  annotations?: Record<string, string> | null;
  isPaused?: boolean;
  updated?: string;
  provenance?: string;
  data?: Array<{ datasourceUid?: string }>;
}

/** `GET /api/v1/provisioning/contact-points`. */
export interface GfContactPoint {
  uid?: string;
  name?: string;
  type?: string;
  disableResolveMessage?: boolean;
  provenance?: string;
}

/** `GET /api/datasources`. */
export interface GfDatasource {
  id?: number;
  uid?: string;
  name?: string;
  type?: string;
  typeName?: string;
  url?: string;
  access?: string;
  isDefault?: boolean;
  readOnly?: boolean;
  basicAuthUser?: string;
}

/** `GET /api/folders`. */
export interface GfFolder {
  uid?: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Synthetic Monitoring API
// ---------------------------------------------------------------------------

export interface SmCheck {
  id?: number;
  tenantId?: number;
  job?: string;
  target?: string;
  enabled?: boolean;
  frequency?: number;
  timeout?: number;
  probes?: number[];
  labels?: Array<{ name?: string; value?: string }>;
  settings?: Record<string, unknown>;
  basicMetricsOnly?: boolean;
  alertSensitivity?: string;
  created?: number;
  modified?: number;
}

export interface SmProbe {
  id?: number;
  name?: string;
  region?: string;
  public?: boolean;
  online?: boolean;
}
