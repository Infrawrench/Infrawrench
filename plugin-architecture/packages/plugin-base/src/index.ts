// Core plugin interfaces
export type {
  Plugin,
  PluginClient,
  PluginManifest,
  CredentialField,
  HostServices,
  SqlHostServices,
  KvHostServices,
  SqlDriverDeclaration,
  KvDriverDeclaration,
  DockerDriverDeclaration,
  DockerHostServices,
  HttpHostServices,
  PeerPaneContext,
} from "./manifest.js";

// Resource type definitions
export type {
  ResourceTypeDefinition,
  FieldDefinition,
  FieldKind,
  AssociationSource,
  ResourceOutput,
  PeerPluginIntegration,
  SecretExportTemplate,
  SecretExportEntry,
} from "./resource.js";

// Resource instances
export type { ResourceInstance } from "./instance.js";

// Secret and association resolution
export type {
  SecretResolution,
  LiteralSecretResolution,
  OutputRefSecretResolution,
  SecretFieldState,
} from "./secrets.js";

// Structural associations
export type { Association } from "./association.js";

// Component schema (rendering primitives)
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
  DashboardCardSchema,
  DetailViewSchema,
  SidebarItemSchema,
  PeerPaneSchema,
  PeerPaneResourceGroup,
  PeerPaneResource,
  SqlEditorCapability,
  SqlTableMeta,
  StorageObject,
  StorageBrowserCapability,
  ManifestEditorCapability,
} from "./schema.js";

// Node.js-side driver interfaces (for Electron main / server hosts)
export type {
  SqlNodeDriver,
  KvNodeDriver,
  DockerNodeDriver,
  StorageNodeDriver,
  PluginNodeDriver,
} from "./node-driver.js";

// Create-resource config (dynamic form schema)
export type {
  CreateResourceConfig,
  CreateSizePricingRequest,
  CreateFieldConfig,
  CreateFieldKind,
  SizeOption,
  RegionOption,
  ImageOption,
  DiskOption,
} from "./create.js";

// Plugin registry
export type { PluginRegistry, PluginRegistryEntry } from "./registry.js";

// Zod validators
export {
  pluginManifestSchema,
  resourceTypeDefinitionSchema,
  fieldDefinitionSchema,
  schemaNodeSchema,
  dashboardCardSchema,
  detailViewSchema,
} from "./validation/index.js";
