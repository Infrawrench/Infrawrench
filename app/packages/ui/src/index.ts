export { useUIStore } from "./store/ui.store.js";
export type { WorkspaceTab, WorkspaceTabTarget } from "./store/ui.store.js";
export {
  getWorkspaceTabFallbackTitle,
  getWorkspaceTabId,
  normalizeResourceId,
  workspaceTabTargetsEqual,
} from "./store/ui.store.js";

export { WorkspaceTabsViewport } from "./workspace/WorkspaceTabsViewport.js";
export { WorkspaceTabProvider, useTabId } from "./workspace/WorkspaceTabContext.js";

export { AgentsPanel } from "./agents/AgentsPanel.js";
export {
  AGENT_BOOTSTRAP_COMPLETE_MARKERS,
  AGENT_CLI_INSTALL_SNIPPET,
  AGENT_MISE_SNIPPET,
  AGENT_NPM_PREFIX_SNIPPET,
  AGENT_SETUP_FAILED_LOG_PREFIX,
  AGENT_SETUP_LOCK_SNIPPET,
  AGENT_SETUP_STEP_PREFIX,
  AGENT_SYSTEM_PACKAGES_SNIPPET,
  agentToolAuthStatusCommand,
  agentToolCommand,
  agentToolLabel,
  agentToolLoginCommand,
  agentToolPackage,
  bootstrapReportedComplete,
  buildAgentBootstrapCommand,
  buildAgentLaunchCommand,
  buildAgentRepoSetupCommand,
  isCloneableGitRepo,
} from "./agents/launch-command.js";
export type {
  AgentBootstrapCommandInput,
  AgentLaunchCommandInput,
} from "./agents/launch-command.js";
export {
  AGENT_ENV_REMOTE_PATH,
  buildAgentEnvFile,
  resolveAgentEnvTemplate,
} from "./agents/repo-config.js";
export {
  agentSurfaceOrDefault,
  agentSurfaceRequiresRepo,
  buildT3CodeBootstrapCommand,
  buildT3CodeConnectCommand,
  buildT3CodeLogoutCommand,
  buildT3CodeStatusCommand,
  createT3CodeSetupPlan,
  isT3CodeSurface,
  parseT3CodeConnectStatus,
  t3CodeConnectNextStep,
  T3_CODE_HOSTED_APP_URL,
  T3_CODE_NODE_ENGINE_RANGE,
  T3_CODE_NODE_VERSION,
  T3_CODE_PROJECTS_DIR,
} from "./agents/t3-code.js";
export type {
  T3CodeBootstrapCommandInput,
  T3CodeConnectCommandInput,
  T3CodeConnectStatus,
} from "./agents/t3-code.js";
export type {
  AgentClient,
  AgentCreateBody,
  AgentLaunchDefaults,
  AgentRepoConfig,
  AgentRepoResourceSpec,
  AgentRuntimeLanguage,
  AgentRuntimePlan,
  AgentRuntimeVersionSource,
  AgentSession,
  AgentSettings,
  AgentSetupPlan,
  AgentSshTarget,
  AgentStatus,
  AgentSurface,
  AgentTool,
  AgentVmAccount,
} from "./agents/types.js";
export { closeSshTabsForAgentTarget, openAgentSshTerminalTab } from "./agents/open-ssh-tab.js";
export type { AgentSshTabTarget, OpenAgentSshTerminalTabInput } from "./agents/open-ssh-tab.js";

export {
  ApprovalCard,
  ApprovalsInbox,
  formatExpiry,
  PromptHost,
  requestWorkflowPrompt,
  resolveWorkflowPrompt,
  WORKFLOW_PROMPT_EVENT,
  WorkflowDashboardCard,
  WorkflowEditorView,
  WorkflowIcon,
  WorkflowsPanel,
} from "./workflows/index.js";
export type {
  ApprovalCardProps,
  ApprovalsClient,
  ApprovalsInboxProps,
  WorkflowApprovalStatus,
  MetricValue,
  PromptHostProps,
  PromptSpec,
  WorkflowPromptRequest,
  BudgetIntegration,
  BudgetOption,
  DebugSession,
  GitIntegration,
  GitRepoOption,
  StoredWorkflowMetricDef,
  WorkflowCardMetric,
  WorkflowClient,
  WorkflowDashboardCardData,
  WorkflowDashboardCardProps,
  WorkflowApprovalRow,
  WorkflowMetricDef,
  WorkflowMetricRow,
  WorkflowRunLog,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSummary,
  WorkflowTrigger,
} from "./workflows/index.js";

export { DeploymentsPanel, DeployIcon } from "./deployments/index.js";
export type {
  DeployEnvs,
  DeployRepo,
  DeployTrigger,
  DeployTriggerInput,
  DeployRunResult,
  DeploySession,
  DeployStage,
  DeployStartOptions,
  DeployStatus,
  DeploymentClient,
  DeploymentRunRow,
  DeploymentsPanelProps,
} from "./deployments/index.js";
export { DEPLOY_STAGES } from "./deployments/index.js";

export { SchemaRenderer, StatusDotNodeRenderer } from "./components/renderer/SchemaRenderer.js";

export { MetricChart } from "./components/charts/MetricChart.js";
export { SparklineChart } from "./components/charts/SparklineChart.js";

export { SpotlightSearch } from "./components/SpotlightSearch.js";
export type { SpotlightSearchProps, SpotlightResult } from "./components/SpotlightSearch.js";
export { MultiSelect } from "./components/MultiSelect.js";
export type {
  MultiSelectProps,
  MultiSelectOption,
  MultiSelectStatus,
} from "./components/MultiSelect.js";

export { GlobalTabBar } from "./components/GlobalTabBar.js";
export type { GlobalTabBarProps } from "./components/GlobalTabBar.js";

export { DashboardCard } from "./components/dashboard/DashboardCard.js";
export { DashboardGrid } from "./components/dashboard/DashboardGrid.js";

export { SidebarItem } from "./components/sidebar/SidebarItem.js";
export { SidebarSection } from "./components/sidebar/SidebarSection.js";
export { SidebarNavGrid, SidebarNavTile } from "./components/sidebar/SidebarNavGrid.js";
export type { SidebarNavTileDef } from "./components/sidebar/SidebarNavGrid.js";

export { OrgSwitcher } from "./components/OrgSwitcher.js";
export type { OrgSwitcherProps, OrgEntry } from "./components/OrgSwitcher.js";

export { FileBrowser } from "./components/FileBrowser.js";
export type { FileBrowserProps } from "./components/FileBrowser.js";

export { ErrorNotice } from "./components/ErrorNotice.js";
export type { ErrorNoticeProps } from "./components/ErrorNotice.js";

export { AccountResourceSections } from "./components/AccountResourceSections.js";
export {
  getVisibleAccountCategories,
  pickDefaultAccountSectionId,
} from "./components/AccountResourceSections.utils.js";
export type {
  AccountResourceSectionsProps,
  SectionTypeDef,
  SectionResource,
  SectionCategoryState,
} from "./components/AccountResourceSections.js";

export { Modal } from "./components/Modal.js";
export { ConfirmDeleteModal } from "./components/ConfirmDeleteModal.js";
export { AddAccountModal } from "./components/AddAccountModal.js";
export type {
  PluginInfo,
  BastionOption,
  AccountReferenceOption,
} from "./components/AddAccountModal.js";
export { EditCredentialsModal } from "./components/EditCredentialsModal.js";
export {
  CredentialPreflightPanel,
  CredentialPreflightModal,
} from "./components/CredentialPreflightPanel.js";
export type {
  CredentialPreflightPanelProps,
  CredentialPreflightModalProps,
} from "./components/CredentialPreflightPanel.js";
export { DockerActionsPanel } from "./components/DockerActionsPanel.js";
export { SshFanoutView } from "./components/SshFanoutView.js";
export type {
  SshFanoutViewProps,
  SshFanoutTargetInfo,
  SshFanoutSnippetInfo,
  SshFanoutRunRequest,
  SshFanoutRunOutcome,
} from "./components/SshFanoutView.js";
export { KvConsole } from "./components/KvConsole.js";
export { tokenize, formatRedisResult } from "./components/KvConsole.utils.js";
export type { KvConsoleProps } from "./components/KvConsole.js";
export { MongoDocumentBrowser } from "./components/MongoDocumentBrowser.js";
export type { MongoDocumentBrowserProps } from "./components/MongoDocumentBrowser.js";
export { FirestoreDocumentBrowser } from "./components/FirestoreDocumentBrowser.js";
export type { FirestoreDocumentBrowserProps } from "./components/FirestoreDocumentBrowser.js";
export { PromptNoSqlCommandModal } from "./components/PromptNoSqlCommandModal.js";
export type { PromptNoSqlCommandModalProps } from "./components/PromptNoSqlCommandModal.js";

export { DetailView } from "./components/detail/DetailView.js";
export { AssociationPicker } from "./components/detail/AssociationPicker.js";
export type {
  RerollSelection,
  ProviderResource,
  PeerPaneData,
  ChildResource,
  ChildResourceGroup,
} from "./components/detail/DetailView.js";
export { PeerPaneView } from "./components/detail/PeerPaneView.js";
export { replacePeerPaneTrailingCount } from "./components/detail/PeerPaneView.utils.js";
export type {
  PeerPaneViewProps,
  PeerPanePortForwardEntry,
} from "./components/detail/PeerPaneView.js";
export { ImportYamlModal } from "./components/ImportYamlModal.js";
export type { ImportYamlModalProps } from "./components/ImportYamlModal.js";
export type { QueryResult } from "./components/detail/SqlEditorView.js";
export { ManifestEditorView } from "./components/detail/ManifestEditorView.js";
export { BucketPolicyEditor } from "./components/detail/BucketPolicyEditor.js";
export { DescribeView } from "./components/detail/DescribeView.js";
export { LogsView } from "./components/detail/LogsView.js";
export { ChatPanel } from "./components/detail/ChatPanel.js";
export { PublishPanel } from "./components/detail/PublishPanel.js";
export { SpeechPanel } from "./components/detail/SpeechPanel.js";
export { ArtifactRegistryView } from "./components/detail/ArtifactRegistryView.js";
export type {
  ArtifactListParams,
  ArtifactListResult,
} from "./components/detail/ArtifactRegistryView.js";
export { KvBrowserView } from "./components/detail/KvBrowserView.js";
export type { KvBrowserListParams } from "./components/detail/KvBrowserView.js";

export { FieldRenderer } from "./components/create-resource/index.js";
export type {
  FieldRendererProps,
  SshKeyPickerCallbacks,
} from "./components/create-resource/index.js";
export { SelectPicker } from "./components/create-resource/index.js";
export { RegionPicker } from "./components/create-resource/index.js";
export { SizePicker } from "./components/create-resource/index.js";
export { SizeCard } from "./components/create-resource/index.js";
export { DiskSlider } from "./components/create-resource/index.js";
export { ImagePicker } from "./components/create-resource/index.js";
export { ImageRow } from "./components/create-resource/index.js";
export { DiskPicker } from "./components/create-resource/index.js";
export { SshKeyPicker } from "./components/create-resource/index.js";
export type {
  SshKeyPickerProps,
  SshKeyEntry,
  SystemSshKey,
  AgentSshKey,
} from "./components/create-resource/index.js";
export { ResourcePicker } from "./components/create-resource/index.js";
export type {
  ResourcePickerOption,
  ResourcePickerCallbacks,
  FieldActionCallbacks,
} from "./components/create-resource/index.js";

export { DndShell } from "./dnd/DndShell.js";
export type { DndShellProps } from "./dnd/DndShell.js";
export { ResourcePill } from "./dnd/ResourcePill.js";
export type { ResourcePillProps } from "./dnd/ResourcePill.js";
export { DraggableChildPill } from "./dnd/DraggableChildPill.js";
export type { DraggableChildPillProps } from "./dnd/DraggableChildPill.js";
export { DroppableDashboardItem } from "./dnd/DroppableDashboardItem.js";
export type { DroppableDashboardItemProps } from "./dnd/DroppableDashboardItem.js";
export { DroppableDashboardArea } from "./dnd/DroppableDashboardArea.js";
export type { DroppableDashboardAreaProps } from "./dnd/DroppableDashboardArea.js";
// Card ordering is pure and mobile renders the same dashboards, so it lives in
// client-core; re-exported here because web and desktop import it from `ui`.
export {
  dashboardCardId,
  parseDashboardCardId,
  orderDashboardCards,
  moveDashboardCard,
  cardOrderIndex,
} from "@infrawrench/client-core";
export type {
  DashboardCardKind,
  DashboardCardRef,
  OrderableDashboardCard,
} from "@infrawrench/client-core";
export { SortableDashboardCard } from "./dnd/SortableDashboardCard.js";
export type { SortableDashboardCardProps } from "./dnd/SortableDashboardCard.js";
export { SortableContext, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
export { DraggableSidebarResource } from "./dnd/DraggableSidebarResource.js";
export type { DraggableSidebarResourceProps } from "./dnd/DraggableSidebarResource.js";
export type { DraggableResource, DraggableWorkflow } from "./dnd/types.js";

export {
  dashboardTabTarget,
  accountTabTarget,
  agentsTabTarget,
  costsTabTarget,
  graphTabTarget,
  logsTabTarget,
  changesTabTarget,
  expiringTabTarget,
  postureTabTarget,
  dnsTabTarget,
  sshFanoutTabTarget,
  metricAlertsTabTarget,
  probesTabTarget,
  chatTabTarget,
  workflowsTabTarget,
  deploymentsTabTarget,
  settingsTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  navigateToWorkspaceTarget,
} from "./workspace-tabs.js";
export type { RouteNavigator } from "./workspace-tabs.js";

// Dependency graph — pure model/layout in client-core (shared contract home);
// re-exported here because web and desktop import it from `ui`.
export {
  buildDependencyGraph,
  directDependencies,
  collectDependents,
  collectDependencies,
  layoutDependencyGraph,
  dependencyEdgeLabel,
  collapseIdenticalNodes,
  inferDependencyEdges,
  collectDependencyRules,
  dependencyRuleKey,
  focusPrefilterTokens,
} from "@infrawrench/client-core";
export type {
  DependencyGraphNode,
  DependencyGraphEdge,
  DependencyEdgeKind,
  DependencyGraphData,
  DependencyGraphModel,
  DependencyNeighbor,
  ResourceDependencies,
  DependencyGraphLayout,
  DependencyGraphLayoutOptions,
  CollapsedDependencyGraph,
  InferenceResource,
  InferDependencyEdgesOptions,
  InferredDependencyEdges,
  DependencyRuleSet,
} from "@infrawrench/client-core";
export { DependencyGraphView } from "./components/graph/DependencyGraphView.js";
export { ResourceDependenciesPanel } from "./components/graph/ResourceDependenciesPanel.js";
export { GraphIcon } from "./components/graph/GraphIcon.js";

export { CreateResourceModal } from "./components/CreateResourceModal.js";
export type { CreateResourceModalProps } from "./components/CreateResourceModal.js";

export { CostEstimateBreakdown, CostEstimateChip } from "./components/CostEstimateChip.js";
export type {
  CostEstimateBreakdownProps,
  CostEstimateChipProps,
} from "./components/CostEstimateChip.js";
export { EditResourceModal } from "./components/EditResourceModal.js";
export type { EditResourceModalProps } from "./components/EditResourceModal.js";
export { TunnelSshAttachModal } from "./components/detail/TunnelSshAttachModal.js";
export type {
  TunnelSshAttachModalProps,
  TunnelSshAttachResult,
  TunnelSshAttachStep,
  TunnelSshAttachZone,
  TunnelSshAttachKey,
  TunnelServiceType,
} from "./components/detail/TunnelSshAttachModal.js";

export { CredentialExportModal } from "./components/CredentialExportModal.js";
export type { CredentialExportModalProps } from "./components/CredentialExportModal.js";
export { useCreateResourceForm } from "./hooks/useCreateResourceForm.js";
export { useWorkspaceTabHandlers } from "./hooks/useWorkspaceTabHandlers.js";
export { useWorkspaceTabDocumentTitle } from "./hooks/useDocumentTitle.js";
export type {
  CreateResourceCallbacks,
  CreateResourceFormState,
} from "./hooks/useCreateResourceForm.js";

export {
  formatSize,
  formatDate,
  groupBy,
  formatErrorMessage,
  evaluateShowWhen,
  buildDefaultFields,
  deriveSSHUsername,
  pickQuickConnectKeyId,
  RESOURCES_CHANGED_EVENT,
  REFRESH_RESOURCE_EVENT,
  NAVIGATE_TO_RESOURCE_EVENT,
  INVOKE_PLUGIN_ACTION_EVENT,
  PROMPT_NOSQL_COMMAND_EVENT,
  REROLL_PARENT_OUTPUT_EVENT,
  dispatchResourcesChanged,
  dispatchRefreshResource,
  dispatchNavigateToResource,
  dispatchInvokePluginAction,
  dispatchPromptNoSqlCommand,
  dispatchRerollParentOutput,
  getListableResourceTypes,
  extractHostLabel,
  buildChildResourceGroups,
  resourceTabTitle,
} from "./utils.js";
export type {
  TransferEntry,
  ResourcesChangedDetail,
  NavigateToResourceDetail,
  InvokePluginActionDetail,
  PromptNoSqlCommandDetail,
  RerollParentOutputDetail,
} from "./utils.js";

export { useChartTheme } from "./chart-theme.js";
export { getTerminalTheme } from "./terminal-theme.js";
export type { TerminalThemeColors } from "./terminal-theme.js";
export { getXtermTerminalOptions, hideXtermScrollbar } from "./xterm-options.js";
export { attachTerminalClipboard, pastedImageFilename } from "./terminal-clipboard.js";
export {
  createTerminalLinkHandler,
  normalizeTerminalLinkUrl,
  openTerminalLinkInNewTab,
} from "./terminal-links.js";
export type { TerminalLinkHandler, TerminalLinkHandlerOptions } from "./terminal-links.js";
export type {
  ClipboardTerminal,
  AttachTerminalClipboardHandle,
  AttachTerminalClipboardOptions,
  TerminalPastedImage,
} from "./terminal-clipboard.js";
export { attachAltBufferScrollHandler } from "./xterm-scroll.js";
export type { ScrollableTerminal, AttachAltBufferScrollHandle } from "./xterm-scroll.js";
export { buildInitialShellCommand, shellQuote } from "./terminal-shell.js";

export { SSH_TUNNEL_PRESETS, buildSshTunnelCredentials } from "./ssh-tunnel-presets.js";
export type { SshTunnelPresetKey } from "./ssh-tunnel-presets.js";

export { runDockerSetupScript } from "./docker-setup-script.js";
export type {
  DockerSetupStep,
  DockerSetupResult,
  DockerSetupContext,
} from "./docker-setup-script.js";

export { FirestoreMongoPeerShell } from "./components/FirestoreMongoPeerShell.js";
export type {
  FirestoreMongoPeerShellProps,
  MongoPeerAccount,
} from "./components/FirestoreMongoPeerShell.js";

export { Toaster, ToastRow, toast, useToast, useToastStore } from "./components/Toast/index.js";
export type { Toast, ToastAction, ToastOptions, ToastVariant } from "./components/Toast/index.js";

export { SshKeyRadioGroup, SshKeyRadioItem } from "./components/SshKeyRadioGroup.js";
export type {
  SshKeyRadioGroupProps,
  SshKeyRadioItemProps,
  SshKeyRadioOption,
} from "./components/SshKeyRadioGroup.js";

export type {
  Account,
  AccountListItem,
  Dashboard,
  SshKey,
  Bastion,
  BillingStatus,
  InvitationSummary,
  Resource,
  ResourceTypeSummary,
  AccountDetail,
  Recipient,
  SubscriptionStatus,
  TeamMember,
} from "./api-types.js";

/**
 * Notification-routing contract (Slack, Microsoft Teams, mobile push). The
 * definitions live in `@infrawrench/client-core` next to the fetch helpers
 * mobile calls; web drives the same endpoints through its own cookie-auth
 * `apiGet`, so it takes the types from here.
 */
export type {
  SlackStatus,
  SlackInstallation,
  SlackChannel,
  SlackChannelTriggers,
  SlackAvailableChannel,
  SlackTestResult,
  AddSlackChannelArgs,
  MsTeamsStatus,
  MsTeamsWebhook,
  MsTeamsWebhookTriggers,
  MsTeamsTestResult,
  AddMsTeamsWebhookArgs,
  DigestSettings,
  DigestSettingsPatch,
  DigestSendResult,
  DigestTransportResult,
  DigestEmailRecipient,
  DigestSendDay,
  DigestStatus,
  PushDeviceSummary,
  PushPreferences,
  PushNotificationData,
} from "@infrawrench/client-core";

/**
 * Change-timeline contract + formatting. Pure and shared with future hosts,
 * so it lives in `@infrawrench/client-core`; re-exported here because web and
 * desktop import shared pieces from `ui`.
 */
export {
  CHANGE_KIND_LABELS,
  DEFAULT_DRIFT_ALERT_SETTINGS,
  DRIFT_ALERT_LIMITS,
  formatChangeValue,
  summarizeChange,
  type DriftAlertSettings,
  type DriftAlertSettingsPatch,
  type ResourceChangeKind,
  type ResourceFieldChange,
  type ResourceChangeEntry,
} from "@infrawrench/client-core";
export { ChangesIcon } from "./components/icons/ChangesIcon.js";
export { LogsIcon } from "./components/icons/LogsIcon.js";

/**
 * Expiry radar — the pure contract (feed computation, wire types, settings
 * helpers) lives in `@infrawrench/client-core` so mobile and the CLI share
 * one definition; re-exported here because web and desktop import it from
 * `ui`.
 */
export {
  computeExpiryFeed,
  fetchExpiring,
  getExpirySettings,
  updateExpirySettings,
  itemsWithinLead,
  EXPIRY_KIND_LABELS,
  EXPIRY_SEVERITIES,
  DEFAULT_EXPIRY_LEAD_DAYS,
} from "@infrawrench/client-core";
export type {
  ExpiryFieldRule,
  ExpiryItem,
  ExpiryKind,
  ExpiryListResponse,
  ExpiryScanAccount,
  ExpiryScanInput,
  ExpiryScanPlugin,
  ExpiryScanResource,
  ExpiryScanResourceType,
  ExpirySettings,
  ExpirySettingsPatch,
  ExpirySeverity,
} from "@infrawrench/client-core";
export { ExpirySection, formatDaysRemaining } from "./expiry/ExpirySection.js";
export type { ExpirySectionProps } from "./expiry/ExpirySection.js";
export { ExpiryIcon } from "./components/icons/ExpiryIcon.js";

/**
 * Posture checks — the pure contract (finding computation, wire types,
 * settings helpers) lives in `@infrawrench/client-core` so mobile and the CLI
 * share one definition; re-exported here because web and desktop import it
 * from `ui`.
 */
export {
  computePostureFindings,
  dismissPostureFinding,
  fetchPosture,
  getPostureSettings,
  postureFindingKey,
  restorePostureFinding,
  updatePostureSettings,
  alertablePostureFindings,
  POSTURE_CATEGORY_LABELS,
  POSTURE_SEVERITIES,
  POSTURE_SEVERITY_LABELS,
} from "@infrawrench/client-core";
export type {
  DismissedPostureFinding,
  PostureCategory,
  PostureCheckRule,
  PostureCondition,
  PostureDismissal,
  PostureDismissInput,
  PostureFinding,
  PostureListResponse,
  PostureScanAccount,
  PostureScanInput,
  PostureScanPlugin,
  PostureScanResource,
  PostureScanResourceType,
  PostureSettings,
  PostureSettingsPatch,
  PostureSeverity,
} from "@infrawrench/client-core";
export { PostureSection } from "./posture/PostureSection.js";
export type { PostureSectionProps } from "./posture/PostureSection.js";
export { PostureIcon } from "./components/icons/PostureIcon.js";
export {
  DNS_CLASSIFICATION_LABELS,
  computeDnsInventory,
  danglingDnsRecords,
  normalizeDnsHost,
} from "@infrawrench/client-core";
export type {
  DnsInventoryResponse,
  DnsRecordEntry,
  DnsRecordTarget,
  DnsScanAccount,
  DnsScanInput,
  DnsScanPlugin,
  DnsScanResource,
  DnsScanResourceType,
  DnsSkippedNamespace,
  DnsTargetClassification,
  DnsZoneEntry,
} from "@infrawrench/client-core";
export { DnsSection } from "./dns/DnsSection.js";
export type { DnsSectionProps } from "./dns/DnsSection.js";
export { DomainsIcon } from "./components/icons/DomainsIcon.js";
export { FanoutIcon } from "./components/icons/FanoutIcon.js";
export { MetricAlertIcon } from "./components/icons/MetricAlertIcon.js";
export { ProbesIcon } from "./components/icons/ProbesIcon.js";

/**
 * SSH host-key trust handshake. Shared with mobile through client-core because
 * all three hosts have to agree on the payload the proxy and the HTTP routes
 * send, and on how the trust POST is shaped.
 */
export {
  isHostKeyTrustResponse,
  trustPayloadFromFrame,
  hostKeyTrustRequestBody,
  hostKeyLabel,
  type HostKeyTrustPayload,
} from "@infrawrench/client-core";

/**
 * Personal-account contract. The definitions live in `@infrawrench/client-core`
 * so mobile can share them; re-exported here because the web and desktop apps
 * depend on `@infrawrench/ui`, not on client-core directly.
 */
export {
  isSeatLimitResponse,
  SeatLimitReachedClientError,
  PlanRequiredClientError,
  type SeatLimitPayload,
} from "@infrawrench/client-core";

export {
  formatProvider,
  formatAuthMethod,
  describeUserAgent,
  REAUTHENTICATION_REQUIRED,
  TRANSFER_OWNERSHIP_REQUIRED,
  isReauthenticationRequired,
  ownershipTransferRequired,
  type Profile,
  type ProfileIdentity,
  type AuthFactor,
  type TotpEnrollment,
  type PendingEmailChange,
  type UserSession,
  type OrganizationRef,
  type OwnershipBlocker,
  type AccountDeletionPreview,
} from "@infrawrench/client-core";

export * from "./cost/index.js";

// Org/user settings — shared sections rendered by the web settings routes and
// the desktop cloud-mode settings tab (see settings/host.tsx for the contract).
export * from "./settings/index.js";
export * from "./metric-alerts/index.js";
export * from "./probes/index.js";
export * from "./savings/index.js";
export * from "./logs/index.js";
export { SleepSchedulesSection } from "./schedules/SleepSchedulesSection.js";
export type { SleepSchedulesSectionProps } from "./schedules/SleepSchedulesSection.js";
export { ScheduleEditorModal } from "./schedules/ScheduleEditorModal.js";
export type {
  ScheduleEditorModalProps,
  ScheduleEditorTarget,
} from "./schedules/ScheduleEditorModal.js";
export { ResourceSchedulePanel } from "./schedules/ResourceSchedulePanel.js";
export type { ResourceSchedulePanelProps } from "./schedules/ResourceSchedulePanel.js";
export type {
  SchedulesClient,
  SleepSchedule,
  SleepScheduleCreate,
  SleepScheduleListResponse,
  SleepSchedulePatch,
  SchedulePreview,
  SchedulePreviewRequest,
} from "./schedules/types.js";
export { LeaseEditorModal } from "./leases/LeaseEditorModal.js";
export type { LeaseEditorModalProps, LeaseEditorTarget } from "./leases/LeaseEditorModal.js";
export { ResourceLeasePanel } from "./leases/ResourceLeasePanel.js";
export type { ResourceLeasePanelProps } from "./leases/ResourceLeasePanel.js";
export type {
  LeasesClient,
  LeaseStatus,
  ResourceLease,
  ResourceLeaseCreate,
  ResourceLeaseListResponse,
  ResourceLeasePatch,
} from "./leases/types.js";

// Named re-exports of cost/custom-graph wire types. The tsdown (tsgo) dts
// bundler drops some `export *` type re-exports when the same name also
// appears as an import into the declaration graph from client-core under
// another path — desktop/web then fail to resolve them from `@infrawrench/ui`.
export type {
  CostAccountStatus,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CostDimensionOption,
  CustomGraphWidgetConfig,
} from "@infrawrench/client-core";

// Named rather than `export *`: the change-timeline wire types are already
// re-exported above straight from client-core, and a star would redeclare them.
export {
  ChangesPanel,
  ChangeKindBadge,
  ChangeDiffList,
  type ChangesPanelProps,
  type ChangesClient,
  type ChangeFeedQuery,
  type ChangeFeedPage,
  type ChangeFeedAccount,
} from "./changes/index.js";

// Moment view ("what changed around 03:14?") — panel + host contract. The
// wire types and pure timeline logic come straight from client-core, named
// for the same redeclaration reason as the changes block above.
export { MomentPanel, type MomentPanelProps, type MomentClient } from "./moment/index.js";
export {
  buildMomentTimeline,
  describeIncidentBadge,
  momentSearchParams,
  MOMENT_FEED_LABELS,
  MOMENT_WINDOW_PRESETS,
  DEFAULT_MOMENT_WINDOW_MINUTES,
  type MomentEvent,
  type MomentEventLink,
  type MomentFeedId,
  type MomentFeedStatus,
  type MomentIncidentSpan,
  type MomentRequest,
  type MomentResponse,
  type MomentSeverity,
  type MomentTimelineItem,
} from "@infrawrench/client-core";

export {
  ProviderIncidentBanner,
  ProviderIncidentChangesSection,
  type ProviderIncidentBannerProps,
  type ProviderIncidentChangesSectionProps,
  type StatusIncidentsClient,
  type OrgStatusIncident,
  type OrgStatusIncidentsResponse,
  type ProviderIncidentImpact,
  type ProviderIncidentResourceSample,
  type ProviderIncidentState,
} from "./status/index.js";

export * from "./custom-graphs/index.js";

export * from "./chat/index.js";
