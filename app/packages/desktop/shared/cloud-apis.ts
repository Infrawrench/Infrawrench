/**
 * The contract domains the desktop calls through its cloud transport, by the
 * name the renderer asks for them with (`cloudClient("probes")`).
 *
 * One list for both ends. The renderer derives its typed client from an
 * entry (`src/lib/cloud-client.ts`), and the main process derives its
 * allowlist from every endpoint of every entry (`electron/cloud-allowlist.ts`),
 * so a domain without an entry cannot be called by name, and a request built
 * for it by hand is refused before it leaves the main process. Migrating a
 * `cloud-data/<area>.ts` file adds its domain here; KNOWLEDGE.md ("Desktop
 * IPC on Effect RPC") has the recipe.
 */
import type { Context } from "effect";
import { HttpApi, type HttpApiEndpoint, type HttpApiGroup } from "effect/http-api";
import {
  AccountsApi,
  AgentsApi,
  ChatApi,
  ComplianceApi,
  ConnectionsApi,
  DeploymentsApi,
  EnvironmentsApi,
  IncidentsApi,
  KubernetesEfficiencyReportsApi,
  PagingProvidersApi,
  ProbesApi,
  ResourceReportsApi,
  SlosApi,
} from "@infrawrench/api-contract";
import {
  AccessReviewApi,
  CalendarApi,
  DnsApi,
  EnvironmentDiffApi,
  ExpiringApi,
  ExtendedSupportApi,
  IdleFindingsApi,
  LeakedSecretsApi,
  MomentApi,
  OrphansApi,
  OwnershipApi,
  PostureApi,
  PriceCatalogApi,
  QuotasApi,
  ResourcesApi,
  RightsizingApi,
  SearchApi,
  SeatsApi,
  SshFanoutApi,
  SshTunnelsApi,
  StarredApi,
  VulnerabilitiesApi,
  WallboardApi,
} from "@infrawrench/api-contract";
import {
  BillingProfilesApi,
  BillingRulesApi,
  BlastRadiusApi,
  CostCanvasesApi,
  CostCentresApi,
  DashboardsApi,
  DependencyGraphApi,
  InvoicesApi,
  OnCallApi,
  ScorecardsApi,
  ServicesApi,
  SshKeysApi,
  TagKeysApi,
  VirtualTagsApi,
  WorkflowApprovalsApi,
  WorkflowSecretsApi,
  WorkflowsApi,
} from "@infrawrench/api-contract";
import {
  BackupsApi,
  CostAnnotationsApi,
  CustomGraphsApi,
  DoraApi,
  IacApi,
  LeasesApi,
  LogWorkspacesApi,
  MetricAlertsApi,
  NetworkFlowsApi,
  QueryMonitorsApi,
  ResourceChangesApi,
  RunbooksApi,
  SavingsFindingsApi,
  SchedulesApi,
  StatusIncidentsApi,
  StatusPagesApi,
} from "@infrawrench/api-contract";
import {
  AlertEmailApi,
  BudgetsApi,
  BusinessMetricsApi,
  CarbonApi,
  CommitmentsApi,
  CostAlertsApi,
  CostAnomalyFeedbackApi,
  CostExportJobsApi,
  CostReportAnomalyAlertsApi,
  CostReportFoldersApi,
  CostReportNotificationsApi,
  CostReportsApi,
  CostScenariosApi,
  CostsApi,
  CreditsApi,
  DashboardNotificationsApi,
  SavedCostFiltersApi,
  SavingsApi,
  TagPolicyApi,
} from "@infrawrench/api-contract";

/** One endpoint of a registered domain, as `HttpApi.reflect` walks it. */
export interface DesktopCloudEndpoint {
  readonly group: string;
  readonly endpoint: HttpApiEndpoint.Top;
  /** The API's, group's and endpoint's annotations merged (parse options live here). */
  readonly annotations: Context.Context<never>;
}

/**
 * A registered domain: the `HttpApi` itself, which the renderer's client type
 * is derived from, and its endpoints walked once, which both ends build from
 * at runtime without needing the API's exact type.
 */
export interface DesktopCloudApi<Api> {
  readonly api: Api;
  readonly endpoints: ReadonlyArray<DesktopCloudEndpoint>;
}

function desktopCloudApi<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): DesktopCloudApi<HttpApi.HttpApi<Id, Groups>> {
  const endpoints: Array<DesktopCloudEndpoint> = [];
  HttpApi.reflect(api, {
    onGroup() {},
    onEndpoint({ group, endpoint, mergedAnnotations }) {
      endpoints.push({ group: group.identifier, endpoint, annotations: mergedAnnotations });
    },
  });
  return { api, endpoints };
}

export const DESKTOP_CLOUD_APIS = {
  probes: desktopCloudApi(ProbesApi),
  slos: desktopCloudApi(SlosApi),
  accessReview: desktopCloudApi(AccessReviewApi),
  calendar: desktopCloudApi(CalendarApi),
  dns: desktopCloudApi(DnsApi),
  environmentDiff: desktopCloudApi(EnvironmentDiffApi),
  expiring: desktopCloudApi(ExpiringApi),
  extendedSupport: desktopCloudApi(ExtendedSupportApi),
  idleFindings: desktopCloudApi(IdleFindingsApi),
  leakedSecrets: desktopCloudApi(LeakedSecretsApi),
  moment: desktopCloudApi(MomentApi),
  orphans: desktopCloudApi(OrphansApi),
  ownership: desktopCloudApi(OwnershipApi),
  posture: desktopCloudApi(PostureApi),
  priceCatalog: desktopCloudApi(PriceCatalogApi),
  quotas: desktopCloudApi(QuotasApi),
  resources: desktopCloudApi(ResourcesApi),
  rightsizing: desktopCloudApi(RightsizingApi),
  search: desktopCloudApi(SearchApi),
  seats: desktopCloudApi(SeatsApi),
  sshFanout: desktopCloudApi(SshFanoutApi),
  sshTunnels: desktopCloudApi(SshTunnelsApi),
  starred: desktopCloudApi(StarredApi),
  vulnerabilities: desktopCloudApi(VulnerabilitiesApi),
  wallboard: desktopCloudApi(WallboardApi),
  connections: desktopCloudApi(ConnectionsApi),
  incidents: desktopCloudApi(IncidentsApi),
  pagingProviders: desktopCloudApi(PagingProvidersApi),
  accounts: desktopCloudApi(AccountsApi),
  agents: desktopCloudApi(AgentsApi),
  chat: desktopCloudApi(ChatApi),
  compliance: desktopCloudApi(ComplianceApi),
  deployments: desktopCloudApi(DeploymentsApi),
  environments: desktopCloudApi(EnvironmentsApi),
  k8sEfficiencyReports: desktopCloudApi(KubernetesEfficiencyReportsApi),
  resourceReports: desktopCloudApi(ResourceReportsApi),
  billingProfiles: desktopCloudApi(BillingProfilesApi),
  billingRules: desktopCloudApi(BillingRulesApi),
  blastRadius: desktopCloudApi(BlastRadiusApi),
  costCanvases: desktopCloudApi(CostCanvasesApi),
  costCentres: desktopCloudApi(CostCentresApi),
  dashboards: desktopCloudApi(DashboardsApi),
  dependencyGraph: desktopCloudApi(DependencyGraphApi),
  invoices: desktopCloudApi(InvoicesApi),
  onCall: desktopCloudApi(OnCallApi),
  scorecards: desktopCloudApi(ScorecardsApi),
  services: desktopCloudApi(ServicesApi),
  sshKeys: desktopCloudApi(SshKeysApi),
  tagKeys: desktopCloudApi(TagKeysApi),
  virtualTags: desktopCloudApi(VirtualTagsApi),
  workflowApprovals: desktopCloudApi(WorkflowApprovalsApi),
  workflowSecrets: desktopCloudApi(WorkflowSecretsApi),
  workflows: desktopCloudApi(WorkflowsApi),
  backups: desktopCloudApi(BackupsApi),
  changes: desktopCloudApi(ResourceChangesApi),
  costAnnotations: desktopCloudApi(CostAnnotationsApi),
  customGraphs: desktopCloudApi(CustomGraphsApi),
  dora: desktopCloudApi(DoraApi),
  iac: desktopCloudApi(IacApi),
  leases: desktopCloudApi(LeasesApi),
  logWorkspaces: desktopCloudApi(LogWorkspacesApi),
  metricAlerts: desktopCloudApi(MetricAlertsApi),
  networkFlows: desktopCloudApi(NetworkFlowsApi),
  queryMonitors: desktopCloudApi(QueryMonitorsApi),
  runbooks: desktopCloudApi(RunbooksApi),
  savingsFindings: desktopCloudApi(SavingsFindingsApi),
  schedules: desktopCloudApi(SchedulesApi),
  statusIncidents: desktopCloudApi(StatusIncidentsApi),
  statusPages: desktopCloudApi(StatusPagesApi),
  alertEmail: desktopCloudApi(AlertEmailApi),
  budgets: desktopCloudApi(BudgetsApi),
  businessMetrics: desktopCloudApi(BusinessMetricsApi),
  carbon: desktopCloudApi(CarbonApi),
  commitments: desktopCloudApi(CommitmentsApi),
  costAlerts: desktopCloudApi(CostAlertsApi),
  costAnomalyFeedback: desktopCloudApi(CostAnomalyFeedbackApi),
  costExportJobs: desktopCloudApi(CostExportJobsApi),
  costReportAnomalyAlerts: desktopCloudApi(CostReportAnomalyAlertsApi),
  costReportFolders: desktopCloudApi(CostReportFoldersApi),
  costReportNotifications: desktopCloudApi(CostReportNotificationsApi),
  costReports: desktopCloudApi(CostReportsApi),
  costScenarios: desktopCloudApi(CostScenariosApi),
  costs: desktopCloudApi(CostsApi),
  credits: desktopCloudApi(CreditsApi),
  dashboardNotifications: desktopCloudApi(DashboardNotificationsApi),
  savedCostFilters: desktopCloudApi(SavedCostFiltersApi),
  savings: desktopCloudApi(SavingsApi),
  tagPolicy: desktopCloudApi(TagPolicyApi),
} as const;

export type DesktopCloudApis = typeof DESKTOP_CLOUD_APIS;
export type DesktopCloudApiName = keyof DesktopCloudApis;
