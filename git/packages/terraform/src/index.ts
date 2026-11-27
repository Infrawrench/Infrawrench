export type {
  CommitResult,
  HeadExpectation,
  HeldLock,
  LockInfo,
  NewStateVersion,
  PurgeResult,
  StateHead,
  StateStore,
  StateVersion,
  VersionPage,
} from "./state/types.js";
export {
  DEFAULT_MAX_STATE_BYTES,
  STATE_FORMAT_VERSION,
  readStateHeader,
  withSerial,
  type StateHeader,
  type StateHeaderResult,
} from "./state/document.js";
export { parseLockInfo, type LockInfoResult } from "./state/lock.js";
export {
  lockState,
  purgeState,
  readState,
  restoreVersion,
  unlockState,
  writeState,
  type LockContext,
  type LockOutcome,
  type PurgeOutcome,
  type ReadOutcome,
  type RestoreContext,
  type RestoreOutcome,
  type UnlockOutcome,
  type UnlockRequest,
  type WriteConflict,
  type WriteContext,
  type WriteOutcome,
} from "./state/backend.js";
export {
  handleStateRequest,
  type StateAuth,
  type StateHandlerOptions,
  type StateRoute,
} from "./state/http.js";
export { MemoryStateStore } from "./state/memory-store.js";

export {
  MAX_PLAN_ATTRIBUTES,
  MAX_PLAN_OUTPUTS,
  MAX_PLAN_RESOURCES,
  PlanFormatError,
  describeReason,
  foldActions,
  planLine,
  summarizePlan,
  type PlanAction,
  type PlanAttributeChange,
  type PlanCounts,
  type PlanOutputChange,
  type PlanResourceChange,
  type PlanSummary,
} from "./plan/summary.js";

export { HclSyntaxError, hclItems, literalString, type HclItem } from "./roots/hcl.js";
export {
  MAX_WORKSPACE_NAME,
  discoverTerraformDirectories,
  discoverTerraformRoots,
  isWorkspaceName,
  resolveLocalSource,
  suggestWorkspaceName,
  type DiscoverLimits,
  type DiscoveryResult,
  type ModuleCall,
  type RootReason,
  type TerraformDirectory,
  type TerraformVariable,
  type TreeNode,
  type TreeReader,
} from "./roots/discover.js";

export {
  BACKEND_OVERRIDE,
  BACKEND_OVERRIDE_FILE,
  DEFAULT_TOKEN_SECRET,
  JOB_TOKEN_USERNAME,
  PipelineInputError,
  SERVICE_TOKEN_PURPOSE,
  backendConfiguration,
  backendEnvironment,
  workspacePipeline,
  workspacePipelineYaml,
  type TerraformProduct,
  type TerraformRelease,
  type WorkspacePipelineInput,
} from "./pipeline/generate.js";
export { Literal, renderYaml, type YamlValue } from "./pipeline/yaml.js";

export {
  MAX_STATE_INSTANCES,
  providerSource,
  stateResourceInstances,
  type StateResourceInstance,
  type StateResources,
} from "./match/state-resources.js";
export {
  matchStateToInventory,
  type InventoryCandidate,
  type MatchBasis,
  type MatchResult,
  type ResourceLink,
} from "./match/match.js";

export {
  MAX_PRICING_CHANGES,
  planPricingInputs,
  type PlanPricingChange,
  type PlanPricingInputs,
  type PricingLiteral,
} from "./plan/pricing.js";
export { pinnedRelease, pinnedVersions } from "./pipeline/releases.js";
export { rootsTouchedBy } from "./roots/touched.js";

export {
  EMPTY_SCOPE,
  UNKNOWN,
  evaluate,
  fromJson,
  hasUnknown,
  isUnknown,
  type HclValue,
  type Scope,
  type Unknown,
} from "./roots/expr.js";
export {
  directoryModel,
  isAutoTfvars,
  tfvarsValues,
  type DirectoryModel,
  type Expression,
  type ModuleModel,
  type ProviderModel,
  type ResourceModel,
  type VariableModel,
} from "./roots/model.js";
export {
  MAX_CONFIGURATION_RESOURCES,
  configurationPricingInputs,
  providerOf,
  valueOf,
  type ConfigurationPricingInputs,
  type ConfigurationResource,
  type ConfigurationValue,
} from "./estimate/inputs.js";
export {
  compareConfigurationEstimates,
  type ConfigurationCostChange,
  type ConfigurationCostChangeLine,
  type ConfigurationCostLine,
  type ConfigurationEstimate,
  type ConfigurationOther,
  type ConfigurationUnpriced,
} from "./estimate/estimate.js";
export {
  SNAPSHOT_LIMITS,
  TERRAFORM_SCANNER_VERSION,
  isSkippedDirectory,
  isTerraformScanFile,
  reachableModules,
  scanTerraformSnapshot,
  snapshotTreeReader,
  type ScannedRoot,
  type TerraformScanResult,
  type TerraformSnapshot,
  type TerraformSnapshotFile,
} from "./scan/scan.js";
export {
  MAX_SUMMARY_TYPES,
  summarizeRoot,
  summarizeScan,
  type TerraformRootSummary,
  type TerraformScanSummary,
} from "./scan/summary.js";
