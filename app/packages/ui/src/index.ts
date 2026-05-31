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

export { SchemaRenderer, StatusDotNodeRenderer } from "./components/renderer/SchemaRenderer.js";

export { MetricChart } from "./components/charts/MetricChart.js";
export { SparklineChart } from "./components/charts/SparklineChart.js";

export { SpotlightSearch } from "./components/SpotlightSearch.js";
export type { SpotlightSearchProps, SpotlightResult } from "./components/SpotlightSearch.js";

export { GlobalTabBar } from "./components/GlobalTabBar.js";
export type { GlobalTabBarProps } from "./components/GlobalTabBar.js";

export { DashboardCard } from "./components/dashboard/DashboardCard.js";
export { DashboardGrid } from "./components/dashboard/DashboardGrid.js";

export { SidebarItem } from "./components/sidebar/SidebarItem.js";
export { SidebarSection } from "./components/sidebar/SidebarSection.js";

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
export { DockerActionsPanel } from "./components/DockerActionsPanel.js";
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
export { SortableDashboardCard } from "./dnd/SortableDashboardCard.js";
export type { SortableDashboardCardProps } from "./dnd/SortableDashboardCard.js";
export { SortableContext, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
export { DraggableSidebarResource } from "./dnd/DraggableSidebarResource.js";
export type { DraggableSidebarResourceProps } from "./dnd/DraggableSidebarResource.js";
export type { DraggableResource, DraggableWorkflow } from "./dnd/types.js";

export {
  dashboardTabTarget,
  accountTabTarget,
  workflowsTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  navigateToWorkspaceTarget,
} from "./workspace-tabs.js";
export type { RouteNavigator } from "./workspace-tabs.js";

export { CreateResourceModal } from "./components/CreateResourceModal.js";
export type { CreateResourceModalProps } from "./components/CreateResourceModal.js";

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
  getAccountResourceTypes,
  getListableResourceTypes,
  isCreateOnlyType,
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
export { getXtermTerminalOptions } from "./xterm-options.js";
export { attachTerminalClipboard } from "./terminal-clipboard.js";
export type { ClipboardTerminal, AttachTerminalClipboardHandle } from "./terminal-clipboard.js";
export { attachAltBufferScrollHandler } from "./xterm-scroll.js";
export type { ScrollableTerminal, AttachAltBufferScrollHandle } from "./xterm-scroll.js";

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
  Resource,
  ResourceTypeSummary,
  AccountDetail,
  Recipient,
} from "./api-types.js";
