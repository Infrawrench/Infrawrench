/**
 * Every API domain served by HttpApi. One line per domain; the server, the
 * spec builder and the domain invariant tests all read this list.
 *
 * A request no domain matches gets the API's 404; under the org tree only
 * once the org tree's auth has let it through, so an unknown path there still
 * answers 401 or 403 first (`orgTreeGuard` in `./prefix-guard.ts`, added by
 * `api/index.ts`).
 */
import type { Domain } from "./domain";
import { costReportNotificationsDomain } from "./domains/cost-report-notifications/index";
import { dashboardNotificationsDomain } from "./domains/dashboard-notifications/index";
import { costReportAnomalyAlertsDomain } from "./domains/cost-report-anomaly-alerts/index";
import { costExportsDomain } from "./domains/cost-exports/index";
import { costExportJobsDomain } from "./domains/cost-export-jobs/index";
import { budgetsDomain } from "./domains/budgets/index";
import { onCallDomain } from "./domains/on-call/index";
import { queryMonitorsDomain } from "./domains/query-monitors/index";
import { runbooksDomain } from "./domains/runbooks/index";
import { pagingProvidersDomain } from "./domains/paging-providers/index";
import { incidentsDomain } from "./domains/incidents/index";
import { probesDomain } from "./domains/probes/index";
import { slosDomain } from "./domains/slos/index";
import { servicesDomain } from "./domains/services/index";
import { scorecardsDomain } from "./domains/scorecards/index";
import { doraDomain } from "./domains/dora/index";
import { ownershipDomain } from "./domains/ownership/index";
import { associationsDomain } from "./domains/associations/index";
import { blastRadiusDomain } from "./domains/blast-radius/index";
import { calendarDomain } from "./domains/calendar/index";
import { changeFreezesDomain } from "./domains/change-freezes/index";
import { dependencyGraphDomain } from "./domains/dependency-graph/index";
import { dnsDomain } from "./domains/dns/index";
import { environmentDiffDomain } from "./domains/environment-diff/index";
import { environmentsDomain } from "./domains/environments/index";
import { leasesDomain } from "./domains/leases/index";
import { schedulesDomain } from "./domains/schedules/index";
import { teamDomain } from "./domains/team/index";
import { apiKeysDomain } from "./domains/api-keys/index";
import { auditDomain } from "./domains/audit/index";
import { sshKeysDomain } from "./domains/ssh-keys/index";
import { bastionsDomain } from "./domains/bastions/index";
import { accessReviewDomain } from "./domains/access-review/index";
import { credentialHygieneDomain } from "./domains/credential-hygiene/index";
import { jitAccessDomain } from "./domains/jit-access/index";
import { accessRequestsDomain } from "./domains/access-requests/index";
import { postureDomain } from "./domains/posture/index";
import { wallboardDomain } from "./domains/wallboard/index";
import { expiringDomain } from "./domains/expiring/index";
import { extendedSupportDomain } from "./domains/extended-support/index";
import { quotasDomain } from "./domains/quotas/index";
import { vulnerabilitiesDomain } from "./domains/vulnerabilities/index";
import { leakedSecretsDomain } from "./domains/leaked-secrets/index";
import { seatsDomain } from "./domains/seats/index";
import { backupsDomain } from "./domains/backups/index";
import { complianceDomain } from "./domains/compliance/index";
import { costReportsDomain } from "./domains/cost-reports/index";
import { costReportFoldersDomain } from "./domains/cost-report-folders/index";
import { costAnnotationsDomain } from "./domains/cost-annotations/index";
import { savedFiltersDomain } from "./domains/saved-filters/index";
import { costAlertsDomain } from "./domains/cost-alerts/index";
import { costAnomalyFeedbackDomain } from "./domains/cost-anomaly-feedback/index";
import { tagKeysDomain } from "./domains/tag-keys/index";
import { tagPolicyDomain } from "./domains/tag-policy/index";
import { slackDomain } from "./domains/slack/index";
import { msTeamsDomain } from "./domains/msteams/index";
import { alertRulesDomain } from "./domains/alert-rules/index";
import { alertEmailDomain } from "./domains/alert-email/index";
import { digestDomain } from "./domains/digest/index";
import { eventSubscriptionsDomain } from "./domains/event-subscriptions/index";
import { jiraDomain } from "./domains/jira/index";
import { linearDomain } from "./domains/linear/index";
import { githubIssuesDomain } from "./domains/github-issues/index";
import { workflowsDomain } from "./domains/workflows/index";
import { workflowApprovalsDomain } from "./domains/workflow-approvals/index";
import { workflowSecretsDomain } from "./domains/workflow-secrets/index";
import { deploymentsDomain } from "./domains/deployments/index";
import { iacDomain } from "./domains/iac/index";
import { prChecksDomain } from "./domains/pr-checks/index";
import { logWorkspacesDomain } from "./domains/log-workspaces/index";
import { aiAttributionDomain } from "./domains/ai-attribution/index";
import { networkFlowsDomain } from "./domains/network-flows/index";
import { wsTokenDomain } from "./domains/ws-token/index";
import { statusIncidentsDomain } from "./domains/status-incidents/index";
import { statusPagesDomain } from "./domains/status-pages/index";
import { calendarFeedDomain } from "./domains/calendar-feed/index";
import { alertEmailUnsubscribeDomain } from "./domains/alert-email-unsubscribe/index";
import { anomalyFeedbackLinkDomain } from "./domains/anomaly-feedback-link/index";
import { githubDomain } from "./domains/github/index";
import { twilioDomain } from "./domains/twilio/index";
import { pushDomain } from "./domains/push/index";
import { k8sEfficiencyReportsDomain } from "./domains/k8s-efficiency-reports/index";
import { resourceReportsDomain } from "./domains/resource-reports/index";
import { resourceChangesDomain } from "./domains/resource-changes/index";
import { currencyDomain } from "./domains/currency/index";
import { costCentresDomain } from "./domains/cost-centres/index";
import { billingRulesDomain } from "./domains/billing-rules/index";
import { virtualTagsDomain } from "./domains/virtual-tags/index";
import { costScenariosDomain } from "./domains/cost-scenarios/index";
import { customCostSourcesDomain } from "./domains/custom-cost-sources/index";
import { orphansDomain } from "./domains/orphans/index";
import { idleFindingsDomain } from "./domains/idle-findings/index";
import { rightsizingDomain } from "./domains/rightsizing/index";
import { commitmentsDomain } from "./domains/commitments/index";
import { creditsDomain } from "./domains/credits/index";
import { carbonDomain } from "./domains/carbon/index";
import { momentDomain } from "./domains/moment/index";
import { priceCatalogDomain } from "./domains/price-catalog/index";
import { savingsDomain } from "./domains/savings/index";
import { savingsFindingsDomain } from "./domains/savings-findings/index";
import { invoicesDomain } from "./domains/invoices/index";
import { billingProfilesDomain } from "./domains/billing-profiles/index";
import { billingDomain } from "./domains/billing/index";
import { businessMetricsDomain } from "./domains/business-metrics/index";
import { dashboardsDomain } from "./domains/dashboards/index";
import { searchDomain } from "./domains/search/index";
import { starredDomain } from "./domains/starred/index";
import { orgFeaturesDomain } from "./domains/org-features/index";
import { productsDomain } from "./domains/products/index";
import { ciDomain } from "./domains/ci/index";
import { ciJobsDomain } from "./domains/ci-jobs/index";
import { orgConfigDomain } from "./domains/org-config/index";
import { costVisibilityDomain } from "./domains/cost-visibility/index";
import { sharingDomain } from "./domains/sharing/index";
import { metricAlertsDomain } from "./domains/metric-alerts/index";
import { customGraphsDomain } from "./domains/custom-graphs/index";
import { costsDomain } from "./domains/costs/index";
import { costCanvasesDomain } from "./domains/cost-canvases/index";
import { accountsDomain } from "./domains/accounts/index";
import { agentsDomain } from "./domains/agents/index";
import { agentRegistrationsDomain } from "./domains/agent-registrations/index";
import { agentLinksDomain } from "./domains/agent-links/index";
import { resourcesDomain } from "./domains/resources/index";
import { costIngestDomain } from "./domains/cost-ingest/index";
import { pagesDomain } from "./domains/pages/index";
import { chatDomain } from "./domains/chat/index";
import { discoveryDomain } from "./domains/discovery/index";
import { apiDocsDomain } from "./domains/api-docs/index";
import { syncDomain } from "./domains/sync/index";
import { whoamiDomain } from "./domains/whoami/index";
import { authDomain } from "./domains/auth/index";
import { profileDomain } from "./domains/profile/index";
import { orgsDomain } from "./domains/orgs/index";
import { invitationsDomain } from "./domains/invitations/index";
import { adminDomain } from "./domains/admin/index";
import { pushDevicesDomain } from "./domains/push-devices/index";
import { awsBulkPricingDomain } from "./domains/aws-bulk-pricing/index";
import { instancePricingDomain } from "./domains/instance-pricing/index";
import { connectionFeaturesDomain } from "./domains/connection-features/index";

import { storageTransfersDomain } from "./domains/storage-transfers/index";
import { sftpTransfersDomain } from "./domains/sftp-transfers/index";
import { sshHostKeysDomain } from "./domains/ssh-host-keys/index";
import { sessionRecordingsDomain } from "./domains/session-recordings/index";
import { sharedConsolesDomain } from "./domains/shared-consoles/index";
import { connectDomain } from "./domains/connect/index";
import { sshTunnelsDomain } from "./domains/ssh-tunnels/index";
import { sshFanoutDomain } from "./domains/ssh-fanout/index";
import { linuxAppsDomain } from "./domains/linux-apps/index";
import { stripeWebhookDomain } from "./domains/stripe-webhook/index";
import { workflowGitWebhookDomain } from "./domains/workflows-git/index";
import { issueWebhooksDomain } from "./domains/issue-webhooks/index";
import { internalRelayDomain } from "./domains/internal-relay/index";
import { callbackDomain } from "./domains/callback/index";
import { slackOAuthDomain } from "./domains/slack-oauth/index";
import { slackInboundDomain } from "./domains/slack-inbound/index";
import { providerOAuthDomain } from "./domains/provider-oauth/index";
import { agentAuthDomain } from "./domains/agent-auth/index";
import { agentLinkPlatformDomain } from "./domains/agent-link-platform/index";

export const DOMAINS: readonly Domain[] = [
  storageTransfersDomain,
  sftpTransfersDomain,
  sshHostKeysDomain,
  sessionRecordingsDomain,
  sharedConsolesDomain,
  connectDomain,
  sshTunnelsDomain,
  sshFanoutDomain,
  linuxAppsDomain,
  costReportNotificationsDomain,
  dashboardNotificationsDomain,
  costReportAnomalyAlertsDomain,
  costExportsDomain,
  costExportJobsDomain,
  budgetsDomain,
  onCallDomain,
  queryMonitorsDomain,
  runbooksDomain,
  pagingProvidersDomain,
  incidentsDomain,
  probesDomain,
  slosDomain,
  servicesDomain,
  scorecardsDomain,
  doraDomain,
  ownershipDomain,
  associationsDomain,
  blastRadiusDomain,
  calendarDomain,
  changeFreezesDomain,
  dependencyGraphDomain,
  dnsDomain,
  environmentDiffDomain,
  environmentsDomain,
  leasesDomain,
  schedulesDomain,
  teamDomain,
  apiKeysDomain,
  auditDomain,
  sshKeysDomain,
  bastionsDomain,
  accessReviewDomain,
  credentialHygieneDomain,
  jitAccessDomain,
  accessRequestsDomain,
  postureDomain,
  wallboardDomain,
  expiringDomain,
  extendedSupportDomain,
  quotasDomain,
  vulnerabilitiesDomain,
  leakedSecretsDomain,
  seatsDomain,
  backupsDomain,
  complianceDomain,
  costReportsDomain,
  costReportFoldersDomain,
  costAnnotationsDomain,
  savedFiltersDomain,
  costAlertsDomain,
  costAnomalyFeedbackDomain,
  tagKeysDomain,
  tagPolicyDomain,
  slackDomain,
  msTeamsDomain,
  alertRulesDomain,
  alertEmailDomain,
  digestDomain,
  eventSubscriptionsDomain,
  jiraDomain,
  linearDomain,
  githubIssuesDomain,
  workflowsDomain,
  workflowApprovalsDomain,
  workflowSecretsDomain,
  deploymentsDomain,
  iacDomain,
  prChecksDomain,
  logWorkspacesDomain,
  aiAttributionDomain,
  networkFlowsDomain,
  currencyDomain,
  costCentresDomain,
  billingRulesDomain,
  virtualTagsDomain,
  costScenariosDomain,
  customCostSourcesDomain,
  invoicesDomain,
  billingProfilesDomain,
  billingDomain,
  businessMetricsDomain,
  dashboardsDomain,
  orphansDomain,
  idleFindingsDomain,
  rightsizingDomain,
  commitmentsDomain,
  creditsDomain,
  carbonDomain,
  momentDomain,
  priceCatalogDomain,
  savingsDomain,
  savingsFindingsDomain,
  searchDomain,
  starredDomain,
  orgFeaturesDomain,
  productsDomain,
  ciDomain,
  orgConfigDomain,
  costVisibilityDomain,
  sharingDomain,
  metricAlertsDomain,
  customGraphsDomain,
  costsDomain,
  costCanvasesDomain,
  wsTokenDomain,
  statusIncidentsDomain,
  statusPagesDomain,
  calendarFeedDomain,
  alertEmailUnsubscribeDomain,
  anomalyFeedbackLinkDomain,
  githubDomain,
  twilioDomain,
  pushDomain,
  k8sEfficiencyReportsDomain,
  resourceReportsDomain,
  resourceChangesDomain,
  accountsDomain,
  agentsDomain,
  agentRegistrationsDomain,
  agentLinksDomain,
  resourcesDomain,
  connectionFeaturesDomain,
  costIngestDomain,
  pagesDomain,
  chatDomain,
  discoveryDomain,
  apiDocsDomain,
  syncDomain,
  whoamiDomain,
  authDomain,
  profileDomain,
  orgsDomain,
  invitationsDomain,
  adminDomain,
  pushDevicesDomain,
  awsBulkPricingDomain,
  instancePricingDomain,
  stripeWebhookDomain,
  workflowGitWebhookDomain,
  issueWebhooksDomain,
  ciJobsDomain,
  internalRelayDomain,
  callbackDomain,
  slackOAuthDomain,
  slackInboundDomain,
  providerOAuthDomain,
  agentAuthDomain,
  agentLinkPlatformDomain,
];
