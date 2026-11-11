/**
 * The Infrawrench HTTP API as Effect HttpApi definitions: every domain's
 * `HttpApi` (endpoints, request and response schemas, error classes and the
 * annotations the server enforces and the OpenAPI document states), plus the
 * client-safe foundation they are built from. No handlers and no server code:
 * the web server serves these definitions, the spec builder documents them,
 * and a client derives a typed client from the same values.
 *
 * Every export is flat. A name two modules both export fails the build here
 * (TS2308), so a schema's export name is unique across the API.
 * Request schemas the UI forms also validate are `./schemas`
 * (`@infrawrench/api-contract/schemas`).
 */
export * from "./http/annotations";
export * from "./http/errors";
export * from "./http/middleware-tags";
export * from "./http/principal";
export * from "./http/api-defaults";
export * from "./http/schemas/agent-links";
export * from "./http/schemas/alert-routing";
export * from "./http/schemas/change-cost-impact";
export * from "./http/schemas/change-freeze";
export * from "./http/schemas/common";
export * from "./http/schemas/cost-anomalies";
export * from "./http/schemas/cost-query";
export * from "./http/schemas/cost-report-folder";
export * from "./http/schemas/cost-visibility";
export * from "./http/schemas/documented";
export * from "./http/schemas/file-transfer";
export * from "./http/schemas/invoicing";
export * from "./http/schemas/issue-status";
export * from "./http/schemas/params";
export * from "./http/schemas/permissions";
export * from "./http/schemas/plugin-registry";
export * from "./http/schemas/posture";
export * from "./http/schemas/pricing";
export * from "./http/schemas/query";
export * from "./http/schemas/raw-query";
export * from "./http/schemas/remediation";
export * from "./http/schemas/report-delivery";
export * from "./http/schemas/search";
export * from "./http/schemas/service-catalog";
export * from "./http/schemas/ssh-host-key-trust";
export * from "./http/schemas/terraform-export";
export * from "./http/schemas/workflow-secrets";

export * from "./domains/access-requests";
export * from "./domains/access-review";
export * from "./domains/accounts";
export * from "./domains/admin";
export * from "./domains/agent-auth";
export * from "./domains/agent-link-platform";
export * from "./domains/agent-links";
export * from "./domains/agent-registrations";
export * from "./domains/agents";
export * from "./domains/ai-attribution";
export * from "./domains/alert-email";
export * from "./domains/alert-email-unsubscribe";
export * from "./domains/alert-rules";
export * from "./domains/anomaly-feedback-link";
export * from "./domains/api-docs";
export * from "./domains/api-keys";
export * from "./domains/associations";
export * from "./domains/audit";
export * from "./domains/auth";
export * from "./domains/aws-bulk-pricing";
export * from "./domains/backups";
export * from "./domains/bastions";
export * from "./domains/billing";
export * from "./domains/billing-profiles";
export * from "./domains/billing-rules";
export * from "./domains/blast-radius";
export * from "./domains/budgets";
export * from "./domains/business-metrics";
export * from "./domains/calendar";
export * from "./domains/calendar-feed";
export * from "./domains/callback";
export * from "./domains/carbon";
export * from "./domains/change-freezes";
export * from "./domains/chat";
export * from "./domains/commitments";
export * from "./domains/compliance";
export * from "./domains/connect";
export * from "./domains/connection-features";
export * from "./domains/cost-alerts";
export * from "./domains/cost-annotations";
export * from "./domains/cost-anomaly-feedback";
export * from "./domains/cost-canvases";
export * from "./domains/cost-centres";
export * from "./domains/cost-export-jobs";
export * from "./domains/cost-exports";
export * from "./domains/cost-ingest";
export * from "./domains/cost-report-anomaly-alerts";
export * from "./domains/cost-report-folders";
export * from "./domains/cost-report-notifications";
export * from "./domains/cost-reports";
export * from "./domains/cost-scenarios";
export * from "./domains/cost-visibility";
export * from "./domains/costs";
export * from "./domains/credential-hygiene";
export * from "./domains/credits";
export * from "./domains/currency";
export * from "./domains/custom-cost-sources";
export * from "./domains/custom-graphs";
export * from "./domains/dashboard-notifications";
export * from "./domains/dashboards";
export * from "./domains/dependency-graph";
export * from "./domains/deployments";
export * from "./domains/digest";
export * from "./domains/discovery";
export * from "./domains/dns";
export * from "./domains/dora";
export * from "./domains/environment-diff";
export * from "./domains/environments";
export * from "./domains/event-subscriptions";
export * from "./domains/expiring";
export * from "./domains/extended-support";
export * from "./domains/github";
export * from "./domains/github-issues";
export * from "./domains/iac";
export * from "./domains/idle-findings";
export * from "./domains/incidents";
export * from "./domains/instance-pricing";
export * from "./domains/internal-relay";
export * from "./domains/invitations";
export * from "./domains/invoices";
export * from "./domains/issue-webhooks";
export * from "./domains/jira";
export * from "./domains/jit-access";
export * from "./domains/k8s-efficiency-reports";
export * from "./domains/leaked-secrets";
export * from "./domains/leases";
export * from "./domains/linear";
export * from "./domains/linux-apps";
export * from "./domains/log-workspaces";
export * from "./domains/metric-alerts";
export * from "./domains/moment";
export * from "./domains/msteams";
export * from "./domains/network-flows";
export * from "./domains/on-call";
export * from "./domains/org-config";
export * from "./domains/orgs";
export * from "./domains/orphans";
export * from "./domains/ownership";
export * from "./domains/pages";
export * from "./domains/paging-providers";
export * from "./domains/posture";
export * from "./domains/pr-checks";
export * from "./domains/price-catalog";
export * from "./domains/probes";
export * from "./domains/profile";
export * from "./domains/provider-oauth";
export * from "./domains/push";
export * from "./domains/push-devices";
export * from "./domains/query-monitors";
export * from "./domains/quotas";
export * from "./domains/resource-changes";
export * from "./domains/resource-reports";
export * from "./domains/resources";
export * from "./domains/rightsizing";
export * from "./domains/runbooks";
export * from "./domains/saved-filters";
export * from "./domains/savings";
export * from "./domains/savings-findings";
export * from "./domains/schedules";
export * from "./domains/scorecards";
export * from "./domains/search";
export * from "./domains/seats";
export * from "./domains/services";
export * from "./domains/session-recordings";
export * from "./domains/sftp-transfers";
export * from "./domains/shared-consoles";
export * from "./domains/sharing";
export * from "./domains/slack";
export * from "./domains/slack-inbound";
export * from "./domains/slack-oauth";
export * from "./domains/slos";
export * from "./domains/ssh-fanout";
export * from "./domains/ssh-host-keys";
export * from "./domains/ssh-keys";
export * from "./domains/ssh-tunnels";
export * from "./domains/starred";
export * from "./domains/org-features";
export * from "./domains/products";
export * from "./domains/ci";
export * from "./domains/status-incidents";
export * from "./domains/status-pages";
export * from "./domains/storage-transfers";
export * from "./domains/stripe-webhook";
export * from "./domains/sync";
export * from "./domains/tag-keys";
export * from "./domains/tag-policy";
export * from "./domains/team";
export * from "./domains/twilio";
export * from "./domains/virtual-tags";
export * from "./domains/vulnerabilities";
export * from "./domains/wallboard";
export * from "./domains/whoami";
export * from "./domains/workflow-approvals";
export * from "./domains/workflow-secrets";
export * from "./domains/workflows";
export * from "./domains/workflows-git";
export * from "./domains/ws-token";
export * from "./domains/dashboards/schemas";

import { AccessRequestsApi } from "./domains/access-requests";
import { AccessReviewApi } from "./domains/access-review";
import { AccountsApi } from "./domains/accounts";
import { AdminApi } from "./domains/admin";
import { AgentAuthApi } from "./domains/agent-auth";
import { AgentLinkPlatformApi } from "./domains/agent-link-platform";
import { AgentLinksApi } from "./domains/agent-links";
import { AgentRegistrationsApi } from "./domains/agent-registrations";
import { AgentsApi } from "./domains/agents";
import { AiAttributionApi } from "./domains/ai-attribution";
import { AlertEmailApi } from "./domains/alert-email";
import { AlertEmailUnsubscribeApi } from "./domains/alert-email-unsubscribe";
import { AlertRulesApi } from "./domains/alert-rules";
import { AnomalyFeedbackLinkApi } from "./domains/anomaly-feedback-link";
import { ApiDocsApi } from "./domains/api-docs";
import { ApiKeysApi } from "./domains/api-keys";
import { AssociationsApi } from "./domains/associations";
import { AuditApi } from "./domains/audit";
import { AuthApi } from "./domains/auth";
import { AwsBulkPricingApi } from "./domains/aws-bulk-pricing";
import { BackupsApi } from "./domains/backups";
import { BastionsApi } from "./domains/bastions";
import { BillingApi } from "./domains/billing";
import { BillingProfilesApi } from "./domains/billing-profiles";
import { BillingRulesApi } from "./domains/billing-rules";
import { BlastRadiusApi } from "./domains/blast-radius";
import { BudgetsApi } from "./domains/budgets";
import { BusinessMetricsApi } from "./domains/business-metrics";
import { CalendarApi } from "./domains/calendar";
import { CalendarFeedApi } from "./domains/calendar-feed";
import { CallbackApi } from "./domains/callback";
import { CarbonApi } from "./domains/carbon";
import { ChangeFreezesApi } from "./domains/change-freezes";
import { ChatApi } from "./domains/chat";
import { CommitmentsApi } from "./domains/commitments";
import { ComplianceApi } from "./domains/compliance";
import { ConnectApi } from "./domains/connect";
import { ConnectionsApi } from "./domains/connection-features";
import { CostAlertsApi } from "./domains/cost-alerts";
import { CostAnnotationsApi } from "./domains/cost-annotations";
import { CostAnomalyFeedbackApi } from "./domains/cost-anomaly-feedback";
import { CostCanvasesApi } from "./domains/cost-canvases";
import { CostCentresApi } from "./domains/cost-centres";
import { CostExportJobsApi } from "./domains/cost-export-jobs";
import { CostExportsApi } from "./domains/cost-exports";
import { CostIngestApi } from "./domains/cost-ingest";
import { CostReportAnomalyAlertsApi } from "./domains/cost-report-anomaly-alerts";
import { CostReportFoldersApi } from "./domains/cost-report-folders";
import { CostReportNotificationsApi } from "./domains/cost-report-notifications";
import { CostReportsApi } from "./domains/cost-reports";
import { CostScenariosApi } from "./domains/cost-scenarios";
import { CostVisibilityApi } from "./domains/cost-visibility";
import { CostsApi } from "./domains/costs";
import { CredentialHygieneApi } from "./domains/credential-hygiene";
import { CreditsApi } from "./domains/credits";
import { CurrencyApi } from "./domains/currency";
import { CustomCostSourcesApi } from "./domains/custom-cost-sources";
import { CustomGraphsApi } from "./domains/custom-graphs";
import { DashboardNotificationsApi } from "./domains/dashboard-notifications";
import { DashboardsApi } from "./domains/dashboards";
import { DependencyGraphApi } from "./domains/dependency-graph";
import { DeploymentsApi } from "./domains/deployments";
import { DigestApi } from "./domains/digest";
import { DiscoveryApi } from "./domains/discovery";
import { DnsApi } from "./domains/dns";
import { DoraApi } from "./domains/dora";
import { EnvironmentDiffApi } from "./domains/environment-diff";
import { EnvironmentsApi } from "./domains/environments";
import { EventSubscriptionsApi } from "./domains/event-subscriptions";
import { ExpiringApi } from "./domains/expiring";
import { ExtendedSupportApi } from "./domains/extended-support";
import { GithubApi } from "./domains/github";
import { GithubIssuesApi } from "./domains/github-issues";
import { IacApi } from "./domains/iac";
import { IdleFindingsApi } from "./domains/idle-findings";
import { IncidentsApi } from "./domains/incidents";
import { InstancePricingApi } from "./domains/instance-pricing";
import { InternalRelayApi } from "./domains/internal-relay";
import { InvitationsApi } from "./domains/invitations";
import { InvoicesApi } from "./domains/invoices";
import { IssueWebhooksApi } from "./domains/issue-webhooks";
import { JiraApi } from "./domains/jira";
import { JitAccessApi } from "./domains/jit-access";
import { KubernetesEfficiencyReportsApi } from "./domains/k8s-efficiency-reports";
import { LeakedSecretsApi } from "./domains/leaked-secrets";
import { LeasesApi } from "./domains/leases";
import { LinearApi } from "./domains/linear";
import { LinuxAppsApi } from "./domains/linux-apps";
import { LogWorkspacesApi } from "./domains/log-workspaces";
import { MetricAlertsApi } from "./domains/metric-alerts";
import { MomentApi } from "./domains/moment";
import { MsTeamsApi } from "./domains/msteams";
import { NetworkFlowsApi } from "./domains/network-flows";
import { OnCallApi } from "./domains/on-call";
import { OrgConfigApi } from "./domains/org-config";
import { OrgsApi } from "./domains/orgs";
import { OrphansApi } from "./domains/orphans";
import { OwnershipApi } from "./domains/ownership";
import { PagesApi } from "./domains/pages";
import { PagingProvidersApi } from "./domains/paging-providers";
import { PostureApi } from "./domains/posture";
import { PrChecksApi } from "./domains/pr-checks";
import { PriceCatalogApi } from "./domains/price-catalog";
import { ProbesApi } from "./domains/probes";
import { ProfileApi } from "./domains/profile";
import { ProviderOAuthApi } from "./domains/provider-oauth";
import { PushApi } from "./domains/push";
import { PushDevicesApi } from "./domains/push-devices";
import { QueryMonitorsApi } from "./domains/query-monitors";
import { QuotasApi } from "./domains/quotas";
import { ResourceChangesApi } from "./domains/resource-changes";
import { ResourceReportsApi } from "./domains/resource-reports";
import { ResourcesApi } from "./domains/resources";
import { RightsizingApi } from "./domains/rightsizing";
import { RunbooksApi } from "./domains/runbooks";
import { SavedCostFiltersApi } from "./domains/saved-filters";
import { SavingsApi } from "./domains/savings";
import { SavingsFindingsApi } from "./domains/savings-findings";
import { SchedulesApi } from "./domains/schedules";
import { ScorecardsApi } from "./domains/scorecards";
import { SearchApi } from "./domains/search";
import { SeatsApi } from "./domains/seats";
import { ServicesApi } from "./domains/services";
import { SessionRecordingsApi } from "./domains/session-recordings";
import { SftpTransfersApi } from "./domains/sftp-transfers";
import { SharedConsolesApi } from "./domains/shared-consoles";
import { SharingApi } from "./domains/sharing";
import { SlackApi } from "./domains/slack";
import { SlackInboundApi } from "./domains/slack-inbound";
import { SlackOAuthApi } from "./domains/slack-oauth";
import { SlosApi } from "./domains/slos";
import { SshFanoutApi } from "./domains/ssh-fanout";
import { SshHostKeysApi } from "./domains/ssh-host-keys";
import { SshKeysApi } from "./domains/ssh-keys";
import { SshTunnelsApi } from "./domains/ssh-tunnels";
import { StarredApi } from "./domains/starred";
import { OrgFeaturesApi } from "./domains/org-features";
import { ProductsApi } from "./domains/products";
import { CiApi } from "./domains/ci";
import { StatusIncidentsApi } from "./domains/status-incidents";
import { StatusPagesApi } from "./domains/status-pages";
import { StorageTransfersApi } from "./domains/storage-transfers";
import { StripeWebhookApi } from "./domains/stripe-webhook";
import { SyncApi } from "./domains/sync";
import { TagKeysApi } from "./domains/tag-keys";
import { TagPolicyApi } from "./domains/tag-policy";
import { TeamApi } from "./domains/team";
import { TwilioApi } from "./domains/twilio";
import { VirtualTagsApi } from "./domains/virtual-tags";
import { VulnerabilitiesApi } from "./domains/vulnerabilities";
import { WallboardApi } from "./domains/wallboard";
import { WhoamiApi } from "./domains/whoami";
import { WorkflowApprovalsApi } from "./domains/workflow-approvals";
import { WorkflowSecretsApi } from "./domains/workflow-secrets";
import { WorkflowsApi } from "./domains/workflows";
import { WorkflowGitWebhookApi } from "./domains/workflows-git";
import { WsTokenApi } from "./domains/ws-token";

/**
 * Every domain's `HttpApi`, keyed by its module name (`domains/<name>`): one
 * entry per domain the web server serves, for clients and tests that walk the
 * whole API.
 */
export const API_DEFINITIONS = {
  "access-requests": AccessRequestsApi,
  "access-review": AccessReviewApi,
  accounts: AccountsApi,
  admin: AdminApi,
  "agent-auth": AgentAuthApi,
  "agent-link-platform": AgentLinkPlatformApi,
  "agent-links": AgentLinksApi,
  "agent-registrations": AgentRegistrationsApi,
  agents: AgentsApi,
  "ai-attribution": AiAttributionApi,
  "alert-email": AlertEmailApi,
  "alert-email-unsubscribe": AlertEmailUnsubscribeApi,
  "alert-rules": AlertRulesApi,
  "anomaly-feedback-link": AnomalyFeedbackLinkApi,
  "api-docs": ApiDocsApi,
  "api-keys": ApiKeysApi,
  associations: AssociationsApi,
  audit: AuditApi,
  auth: AuthApi,
  "aws-bulk-pricing": AwsBulkPricingApi,
  backups: BackupsApi,
  bastions: BastionsApi,
  billing: BillingApi,
  "billing-profiles": BillingProfilesApi,
  "billing-rules": BillingRulesApi,
  "blast-radius": BlastRadiusApi,
  budgets: BudgetsApi,
  "business-metrics": BusinessMetricsApi,
  calendar: CalendarApi,
  "calendar-feed": CalendarFeedApi,
  callback: CallbackApi,
  carbon: CarbonApi,
  "change-freezes": ChangeFreezesApi,
  chat: ChatApi,
  commitments: CommitmentsApi,
  compliance: ComplianceApi,
  connect: ConnectApi,
  "connection-features": ConnectionsApi,
  "cost-alerts": CostAlertsApi,
  "cost-annotations": CostAnnotationsApi,
  "cost-anomaly-feedback": CostAnomalyFeedbackApi,
  "cost-canvases": CostCanvasesApi,
  "cost-centres": CostCentresApi,
  "cost-export-jobs": CostExportJobsApi,
  "cost-exports": CostExportsApi,
  "cost-ingest": CostIngestApi,
  "cost-report-anomaly-alerts": CostReportAnomalyAlertsApi,
  "cost-report-folders": CostReportFoldersApi,
  "cost-report-notifications": CostReportNotificationsApi,
  "cost-reports": CostReportsApi,
  "cost-scenarios": CostScenariosApi,
  "cost-visibility": CostVisibilityApi,
  costs: CostsApi,
  "credential-hygiene": CredentialHygieneApi,
  credits: CreditsApi,
  currency: CurrencyApi,
  "custom-cost-sources": CustomCostSourcesApi,
  "custom-graphs": CustomGraphsApi,
  "dashboard-notifications": DashboardNotificationsApi,
  dashboards: DashboardsApi,
  "dependency-graph": DependencyGraphApi,
  deployments: DeploymentsApi,
  digest: DigestApi,
  discovery: DiscoveryApi,
  dns: DnsApi,
  dora: DoraApi,
  "environment-diff": EnvironmentDiffApi,
  environments: EnvironmentsApi,
  "event-subscriptions": EventSubscriptionsApi,
  expiring: ExpiringApi,
  "extended-support": ExtendedSupportApi,
  github: GithubApi,
  "github-issues": GithubIssuesApi,
  iac: IacApi,
  "idle-findings": IdleFindingsApi,
  incidents: IncidentsApi,
  "instance-pricing": InstancePricingApi,
  "internal-relay": InternalRelayApi,
  invitations: InvitationsApi,
  invoices: InvoicesApi,
  "issue-webhooks": IssueWebhooksApi,
  jira: JiraApi,
  "jit-access": JitAccessApi,
  "k8s-efficiency-reports": KubernetesEfficiencyReportsApi,
  "leaked-secrets": LeakedSecretsApi,
  leases: LeasesApi,
  linear: LinearApi,
  "linux-apps": LinuxAppsApi,
  "log-workspaces": LogWorkspacesApi,
  "metric-alerts": MetricAlertsApi,
  moment: MomentApi,
  msteams: MsTeamsApi,
  "network-flows": NetworkFlowsApi,
  "on-call": OnCallApi,
  "org-config": OrgConfigApi,
  orgs: OrgsApi,
  orphans: OrphansApi,
  ownership: OwnershipApi,
  pages: PagesApi,
  "paging-providers": PagingProvidersApi,
  posture: PostureApi,
  "pr-checks": PrChecksApi,
  "price-catalog": PriceCatalogApi,
  probes: ProbesApi,
  profile: ProfileApi,
  "provider-oauth": ProviderOAuthApi,
  push: PushApi,
  "push-devices": PushDevicesApi,
  "query-monitors": QueryMonitorsApi,
  quotas: QuotasApi,
  "resource-changes": ResourceChangesApi,
  "resource-reports": ResourceReportsApi,
  resources: ResourcesApi,
  rightsizing: RightsizingApi,
  runbooks: RunbooksApi,
  "saved-filters": SavedCostFiltersApi,
  savings: SavingsApi,
  "savings-findings": SavingsFindingsApi,
  schedules: SchedulesApi,
  scorecards: ScorecardsApi,
  search: SearchApi,
  seats: SeatsApi,
  services: ServicesApi,
  "session-recordings": SessionRecordingsApi,
  "sftp-transfers": SftpTransfersApi,
  "shared-consoles": SharedConsolesApi,
  sharing: SharingApi,
  slack: SlackApi,
  "slack-inbound": SlackInboundApi,
  "slack-oauth": SlackOAuthApi,
  slos: SlosApi,
  "ssh-fanout": SshFanoutApi,
  "ssh-host-keys": SshHostKeysApi,
  "ssh-keys": SshKeysApi,
  "ssh-tunnels": SshTunnelsApi,
  starred: StarredApi,
  orgFeatures: OrgFeaturesApi,
  products: ProductsApi,
  ci: CiApi,
  "status-incidents": StatusIncidentsApi,
  "status-pages": StatusPagesApi,
  "storage-transfers": StorageTransfersApi,
  "stripe-webhook": StripeWebhookApi,
  sync: SyncApi,
  "tag-keys": TagKeysApi,
  "tag-policy": TagPolicyApi,
  team: TeamApi,
  twilio: TwilioApi,
  "virtual-tags": VirtualTagsApi,
  vulnerabilities: VulnerabilitiesApi,
  wallboard: WallboardApi,
  whoami: WhoamiApi,
  "workflow-approvals": WorkflowApprovalsApi,
  "workflow-secrets": WorkflowSecretsApi,
  workflows: WorkflowsApi,
  "workflows-git": WorkflowGitWebhookApi,
  "ws-token": WsTokenApi,
} as const;

export type ApiDomainName = keyof typeof API_DEFINITIONS;

/** {@link API_DEFINITIONS} as a list. */
export const ALL_APIS = Object.values(API_DEFINITIONS);
