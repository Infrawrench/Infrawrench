export { useUIStore } from "./store/ui.store.js";
export type { WorkspaceTab, WorkspaceTabTarget } from "./store/ui.store.js";
export {
  getWorkspaceTabFallbackTitle,
  getWorkspaceTabId,
  normalizeResourceId,
  workspaceTabTargetsEqual,
} from "./store/ui.store.js";

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

export { Modal } from "./components/Modal.js";
export { ConfirmDeleteModal } from "./components/ConfirmDeleteModal.js";
export { AddAccountModal } from "./components/AddAccountModal.js";
export type { PluginInfo } from "./components/AddAccountModal.js";
export { DockerActionsPanel } from "./components/DockerActionsPanel.js";
export { KvConsole, tokenize, formatRedisResult } from "./components/KvConsole.js";
export type { KvConsoleProps } from "./components/KvConsole.js";
export { MongoDocumentBrowser } from "./components/MongoDocumentBrowser.js";
export type { MongoDocumentBrowserProps } from "./components/MongoDocumentBrowser.js";

export { DetailView } from "./components/detail/DetailView.js";
export { AssociationPicker } from "./components/detail/AssociationPicker.js";
export type {
  RerollSelection,
  ProviderResource,
  PeerPaneData,
  ChildResource,
  ChildResourceGroup,
} from "./components/detail/DetailView.js";
export type { QueryResult } from "./components/detail/SqlEditorView.js";
export { ManifestEditorView } from "./components/detail/ManifestEditorView.js";

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
export type { DraggableResource } from "./dnd/types.js";

export {
  dashboardTabTarget,
  accountTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  navigateToWorkspaceTarget,
} from "./workspace-tabs.js";
export type { RouteNavigator } from "./workspace-tabs.js";

export { CreateResourceModal } from "./components/CreateResourceModal.js";
export type { CreateResourceModalProps } from "./components/CreateResourceModal.js";
export { useCreateResourceForm } from "./hooks/useCreateResourceForm.js";
export { useWorkspaceTabHandlers } from "./hooks/useWorkspaceTabHandlers.js";
export type {
  CreateResourceCallbacks,
  CreateResourceFormState,
} from "./hooks/useCreateResourceForm.js";

export {
  formatSize,
  formatDate,
  humanizeIdentifier,
  groupBy,
  formatErrorMessage,
  evaluateShowWhen,
  buildDefaultFields,
  deriveSSHUsername,
  RESOURCES_CHANGED_EVENT,
  REFRESH_RESOURCE_EVENT,
  dispatchResourcesChanged,
  dispatchRefreshResource,
  getAccountResourceTypes,
  getListableResourceTypes,
  isCreateOnlyType,
  extractHostLabel,
  buildChildResourceGroups,
  resourceTabTitle,
} from "./utils.js";
export type { TransferEntry, SftpConfig } from "./utils.js";
