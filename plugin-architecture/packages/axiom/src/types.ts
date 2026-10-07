/**
 * Wire types for Axiom's REST API, from Axiom's published OpenAPI documents
 * (axiomhq/docs `content/docs/(api-reference)/restapi/versions/v1.json`,
 * `v2.json`, `v1-edge-query.json`, 2026-10). Every field is optional here
 * because listers must survive partial bodies.
 */

export interface AxOrg {
  id?: string;
  name?: string;
  plan?: string;
  planCreated?: string;
  paymentStatus?: string;
  defaultEdgeDeployment?: string;
  primaryEmail?: string;
  lastUsageSync?: string;
  role?: string;
  license?: {
    tier?: string;
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
    edgeDeployments?: string[];
    maxDatasets?: number;
    maxMonitors?: number;
    maxUsers?: number;
    maxFields?: number;
    maxEndpoints?: number;
    maxQueryWindowSeconds?: number;
    monthlyIngestGb?: number;
    monthlyQueryGbHours?: number;
    storageAllowanceGB?: number;
    apiRateLimitPerSecond?: number;
  };
}

export interface AxDataset {
  id?: string;
  name?: string;
  description?: string;
  kind?: string;
  created?: string;
  updatedAt?: string;
  who?: string;
  retentionDays?: number;
  useRetentionPeriod?: boolean;
  edgeDeployment?: string;
  edgeDeploymentUrl?: string;
  mapFields?: string[];
  sharedByOrg?: string;
  canWrite?: boolean;
}

export interface AxField {
  name?: string;
  type?: string;
  unit?: string;
  description?: string;
  hidden?: boolean;
}

export interface AxVirtualField {
  id?: string;
  dataset?: string;
  name?: string;
  expression?: string;
  description?: string;
  type?: string;
  unit?: string;
}

export type AxMonitorType = "Threshold" | "MatchEvent" | "AnomalyDetection";

export interface AxMonitor {
  id?: string;
  name?: string;
  description?: string;
  type?: AxMonitorType | string;
  aplQuery?: string;
  mplQuery?: string;
  operator?: string;
  threshold?: number;
  columnName?: string;
  intervalMinutes?: number;
  rangeMinutes?: number;
  alertOnNoData?: boolean;
  notifyByGroup?: boolean;
  notifyEveryRun?: boolean;
  resolvable?: boolean;
  skipResolved?: boolean;
  disabled?: boolean;
  disabledUntil?: string;
  notifierIds?: string[];
  compareDays?: number;
  tolerance?: number;
  secondDelay?: number;
  triggerAfterNPositiveResults?: number;
  triggerFromNRuns?: number;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
}

export interface AxMonitorAlert {
  checkId?: string;
  name?: string;
  state?: "open" | "closed" | string;
  timestamp?: string;
}

export interface AxNotifierProperties {
  email?: { emails?: string[] };
  slack?: { slackUrl?: string };
  webhook?: { url?: string };
  customWebhook?: {
    url?: string;
    body?: string;
    headers?: Record<string, string>;
    secretHeaders?: Record<string, string>;
  };
  pagerduty?: { routingKey?: string; token?: string };
  opsgenie?: { apiKey?: string; isEU?: boolean };
  microsoftTeams?: { microsoftTeamsUrl?: string };
  discord?: { discordChannel?: string; discordToken?: string };
  discordWebhook?: { discordWebhookUrl?: string };
}

export interface AxNotifier {
  id?: string;
  name?: string;
  properties?: AxNotifierProperties;
  disabledUntil?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
}

export interface AxDashboardDoc {
  name?: string;
  owner?: string;
  description?: string;
  charts?: Array<{ id?: string; type?: string; name?: string }>;
  layout?: unknown[];
  refreshTime?: number;
  schemaVersion?: number;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  against?: string;
  uid?: string;
  [key: string]: unknown;
}

export interface AxDashboard {
  id?: string;
  uid?: string;
  version?: number;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  dashboard?: AxDashboardDoc;
}

export interface AxView {
  id?: string;
  name?: string;
  description?: string;
  aplQuery?: string;
  datasets?: string[];
  who?: string;
}

export interface AxStarredQuery {
  id?: string;
  name?: string;
  dataset?: string;
  kind?: string;
  who?: string;
  query?: { apl?: string; startTime?: string; endTime?: string };
  metadata?: Record<string, unknown>;
  created?: string;
}

export interface AxAnnotation {
  id?: string;
  title?: string;
  description?: string;
  type?: string;
  url?: string;
  time?: string;
  endTime?: string;
  datasets?: string[];
}

export type AxCapabilities = Record<string, string[] | undefined>;

export interface AxToken {
  id?: string;
  name?: string;
  description?: string;
  expiresAt?: string;
  orgCapabilities?: AxCapabilities;
  datasetCapabilities?: Record<string, AxCapabilities>;
  viewCapabilities?: Record<string, AxCapabilities>;
  samlAuthenticated?: boolean;
  token?: string;
}

export interface AxUser {
  id?: string;
  name?: string;
  email?: string;
  role?: { id?: string; name?: string };
}
