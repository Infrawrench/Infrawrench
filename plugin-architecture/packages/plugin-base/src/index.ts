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

export type { CostCapabilityDeclaration, CostFetchRange, CostHelpLink, CostRow } from "./cost.js";
export { CostSetupError } from "./cost.js";

export type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "./preflight.js";

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
export { evaluatePeerIntegrationUnreachable, evaluateOrphanRule } from "./resource.js";

// Orphan aggregation — the host-side scan over already-stored resources, plus
// the shape every surface renders. Shared so the web server, the desktop app
// and the CLI classify a workspace identically.
export { collectOrphanGroups, countOrphans } from "./orphans.js";
export type {
  OrphanCostAnnotation,
  OrphanCostBasis,
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
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
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

export {
  pluginManifestSchema,
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

export { base64ToBytes, bytesToBase64, utf8ToBase64, base64ToUtf8 } from "./base64.js";
