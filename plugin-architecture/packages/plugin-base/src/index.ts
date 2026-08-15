export type {
  Plugin,
  PluginClient,
  PluginManifest,
  CredentialField,
  CredentialFieldRegion,
  CredentialExport,
  CredentialExportField,
  HostServices,
  SqlHostServices,
  KvHostServices,
  SqlDriverDeclaration,
  KvDriverDeclaration,
  DockerDriverDeclaration,
  DockerHostServices,
  KubernetesHostServices,
  HttpHostServices,
  SecretHostServices,
  PeerPaneContext,
  LogsFetchParams,
  LogsFetchResult,
  RateLimitDeclaration,
} from "./manifest.js";

export type {
  CommitmentKind,
  CommitmentPaymentOption,
  CommitmentProviderUtilization,
  CommitmentRecord,
  CommitmentsCapabilityDeclaration,
  CommitmentState,
  CommitmentUnitAmount,
  CostCapabilityDeclaration,
  CostEstimate,
  CostEstimateLineItem,
  CostChargeType,
  CostFetchRange,
  CostFetchResult,
  CostHelpLink,
  CostRow,
} from "./cost.js";
export {
  buildCostEstimate,
  costEstimateDelta,
  CostSetupError,
  normalizeCostFetchResult,
} from "./cost.js";
export type { CreditBalance, CreditsCapabilityDeclaration } from "./credits.js";
export { CreditAccessError } from "./credits.js";

export type { QuotaCapabilityDeclaration, QuotaUsage } from "./quotas.js";
export { normalizeQuotaUsage, QuotaAccessError, quotaUtilization } from "./quotas.js";

export type {
  NetworkFlowAttribution,
  NetworkFlowCapabilityDeclaration,
  NetworkFlowDirection,
  NetworkFlowEndpoint,
  NetworkFlowFetchRange,
  NetworkFlowFetchResult,
  NetworkFlowRateCard,
  NetworkFlowRecord,
  NetworkFlowScope,
  NetworkFlowSource,
  NetworkFlowTotal,
} from "./network-flow.js";
export {
  BYTES_PER_PRICING_GB,
  NETWORK_FLOW_SCOPES,
  NetworkFlowSetupError,
  normalizeNetworkFlowResult,
} from "./network-flow.js";

export type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "./preflight.js";
export { validatePreflightContract } from "./preflight.js";

export type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
  StatusComponentMapping,
  StatuspageParseOptions,
  StatusFeedXmlItem,
} from "./status-feed.js";
export { parseStatuspageIncidents, parseStatusFeedXml, stripStatusHtml } from "./status-feed.js";

export type {
  ResourceTypeDefinition,
  FieldDefinition,
  FieldKind,
  AssociationSource,
  ResourceOutput,
  PeerPluginIntegration,
  ResourceDependencyRule,
  SecretExportTemplate,
  SecretExportEntry,
  CredentialFormat,
  AttachTarget,
  AgentVmCapability,
  OrphanCondition,
  OrphanRule,
  ExpiryKind,
  ExpiryFieldRule,
  DnsRoleDeclaration,
  DnsZoneRole,
  DnsRecordRole,
  DnsServiceHostRule,
  BackupRoleKind,
  BackupRoleDeclaration,
  BackupPolicyDeclaration,
  LifecycleActionsDeclaration,
  RightsizingDeclaration,
  RightsizingCpuMetric,
  RightsizingMemoryMetric,
} from "./resource.js";

export type {
  ResourceInstance,
  ResourceWarning,
  ResourceCreateResult,
  ResourceCreateReturn,
} from "./instance.js";
export { normalizeResourceCreateResult } from "./instance.js";
export {
  evaluatePeerIntegrationUnreachable,
  evaluateOrphanRule,
  isFieldEditable,
} from "./resource.js";

// Posture checks — declarative security-exposure rules over already-synced
// fields, the security sibling of `orphanRule`. The workspace-wide aggregation
// lives in `@infrawrench/client-core` (`computePostureFindings`).
export { evaluatePostureRule, evaluatePostureCondition, parsePostureInstant } from "./posture.js";
export type {
  PostureCheckRule,
  PostureCondition,
  PostureSeverity,
  PostureCategory,
} from "./posture.js";

// Principals — the identities inside the *customer's* clouds (IAM users and
// roles, service accounts, app registrations, bindings, long-lived keys). The
// workspace-wide review lives in `@infrawrench/client-core`
// (`computeAccessReview`); this is only the declaration and its defaults.
export {
  resolvePrincipalKeys,
  DEFAULT_PRINCIPAL_LAST_USED_KEY,
  DEFAULT_PRINCIPAL_CREATED_KEY,
} from "./principal.js";
export type {
  PrincipalRole,
  PrincipalRoleDeclaration,
  ResolvedPrincipalKeys,
} from "./principal.js";

// Orphan aggregation — the host-side scan over already-stored resources, plus
// the shape every surface renders. Shared so the web server, the desktop app
// and the CLI classify a workspace identically.
export { collectOrphanGroups, countOrphans, countUnownedOrphans } from "./orphans.js";
export type {
  OrphanCostAnnotation,
  OrphanCostBasis,
  ResourceOwnerAnnotation,
  OrphanedResource,
  OrphanAccountGroup,
  OrphanListResponse,
  OrphanScanResourceType,
  OrphanScanPlugin,
  OrphanScanAccount,
  OrphanScanResource,
  OrphanScanInput,
} from "./orphans.js";
export { field, output, resourceType, f, o, rt } from "./resource-builders.js";
export type { CompactField, CompactOutput, CompactResourceType } from "./resource-builders.js";

export type {
  SecretResolution,
  LiteralSecretResolution,
  OutputRefSecretResolution,
  PlaintextSecretResolution,
  SecretFieldState,
} from "./secrets.js";

export type { Association } from "./association.js";

export type {
  SchemaNode,
  TextNode,
  BadgeNode,
  ResourceStatus,
  StatusDotNode,
  SecretValuePlaceholder,
  KVItem,
  KeyValueListNode,
  ActionNode,
  GridNode,
  SectionNode,
  LinkNode,
  HostAction,
  DashboardStat,
  DashboardCardSchema,
  ChildGroupSchema,
  ChildTableSchema,
  ChildTableColumn,
  DetailViewTab,
  DetailViewSchema,
  SidebarItemSchema,
  PeerPaneSchema,
  PeerGuidanceAction,
  PeerPaneResourceGroup,
  PeerPaneResource,
  SqlEditorCapability,
  SqlTableMeta,
  QueryCostEstimate,
  StorageObject,
  StorageBrowserCapability,
  KvKeyEntry,
  KvListResult,
  KvBrowserCapability,
  ArtifactEntry,
  ArtifactRegistryCapability,
  ManifestEditorCapability,
  SettingsEditorCapability,
  SettingDescriptor,
  BucketPolicyEditorCapability,
  DescribeCapability,
  LogsCapability,
  SecretVersion,
  SecretVersionState,
  SecretVersionMutation,
  SecretVersionsCapability,
  MetricSeriesPoint,
  MetricSeries,
  MetricChartNode,
  TableColumn,
  TableRow,
  TableNode,
  ChatPanelCapability,
  ChatMessage,
  ChatStreamEvent,
  PublishPanelCapability,
  PublishPanelField,
  PublishMessagePayload,
  PublishMessageResult,
  SpeechPanelCapability,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "./schema.js";

export type {
  SqlNodeDriver,
  SqlNodeDriverOptions,
  KvNodeDriver,
  DockerNodeDriver,
  K8sNodeDriver,
  StorageNodeDriver,
  StorageDownloadOptions,
  PluginNodeDriver,
} from "./node-driver.js";

export type {
  CreateResourceConfig,
  CreateSizePricingRequest,
  CreateFieldConfig,
  CreateFieldKind,
  ShowWhenCondition,
  ShowWhenRule,
  DatetimeMode,
  SizeOption,
  RegionOption,
  ImageOption,
  DiskOption,
  PolicyOption,
  SelectOption,
  FieldAction,
  FieldActionResult,
} from "./create.js";

export {
  encodeOutputRef,
  parseOutputRef,
  isOutputRefValue,
  OUTPUT_REF_PREFIX,
} from "./output-ref.js";
export type { OutputRefValue } from "./output-ref.js";

export {
  camelToTitle,
  joinSubtitle,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
  resourceTypeHasMetrics,
  withMetricsCapability,
} from "./render-helpers.js";

export {
  dnsRecordBadgeColor,
  formatDnsTtl,
  dnsZoneStatus,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
} from "./dns.js";
export type { DnsRecordDetailOptions } from "./dns.js";

export {
  dnsContentField,
  PICKABLE_DNS_TYPES,
  DNS_IPV4_SOURCES,
  DNS_IPV6_SOURCES,
  DNS_HOSTNAME_SOURCES,
} from "./dns-helpers.js";
export type { DnsContentFieldOptions } from "./dns-helpers.js";

export { jsonRestFetch, formatBytes, caCertCredentialField } from "./http.js";
export type { JsonRestFetchOptions } from "./http.js";

export { streamOpenAiSseChat } from "./chat-stream.js";
export { decodePromptArgs } from "./prompt-args.js";

export { signedS3Fetch } from "./signed-s3-request.js";
export type { SignedS3FetchOptions } from "./signed-s3-request.js";

export {
  listS3Objects,
  uploadS3Object,
  deleteS3Object,
  makeS3Folder,
  getS3BucketPolicy,
  putS3BucketPolicy,
  virtualHostedUrl,
  pathStyleUrl,
} from "./s3-storage-helpers.js";
export type { S3StorageConfig } from "./s3-storage-helpers.js";

export type {
  SftpConfig,
  SshConfig,
  SshTunnelConfig,
  ProbeStatus,
  HostKeyPromptKind,
  HostKeyPromptPayload,
  K8sExecConfig,
  K9sConfig,
  CredentialRewriter,
  RewriterContext,
} from "./host-types.js";

export type {
  TerraformProviderRequirement,
  TerraformVariable,
  TerraformValue,
  TerraformResourceBlock,
  TerraformExportResult,
  TerraformExportCapability,
} from "./terraform.js";
export { tf } from "./terraform.js";
export {
  sanitizeTerraformName,
  renderTerraformValue,
  renderTerraformBundle,
} from "./terraform-hcl.js";
export type {
  TerraformProviderSection,
  RenderedTerraformResource,
  RenderedTerraformBundle,
} from "./terraform-hcl.js";
export {
  exportResourcesToTerraform,
  exportResourcesForAdoption,
  renderTerraformImportBlocks,
  NO_IMPORT_ID_REASON,
  fieldString,
  fieldNumber,
  fieldBool,
} from "./terraform-export.js";
export type {
  TerraformExportOutcome,
  TerraformAdoptionOutcome,
  TerraformExportedResource,
  TerraformUnsupportedResource,
} from "./terraform-export.js";

export {
  pluginManifestSchema,
  terraformExportCapabilitySchema,
  resourceTypeDefinitionSchema,
  fieldDefinitionSchema,
  schemaNodeSchema,
  dashboardCardSchema,
  detailViewSchema,
  metricSeriesSchema,
  metricSeriesPointSchema,
  queryCostEstimateSchema,
  queryResultSchema,
  queryExecuteResultSchema,
} from "./validation/index.js";

export { isInertSvg, findUnsafeSvgConstructs } from "./svg-safety.js";

export { base64ToBytes, bytesToBase64, utf8ToBase64, base64ToUtf8 } from "./base64.js";
