import type { PeerPaneSchema, StatusDotNode } from "@infrawrench/plugin-base";

export interface PeerPaneData {
  tabLabel: string;
  pluginLogoSvg: string;
  credentials: Record<string, string>;
  schema: PeerPaneSchema;
  /**
   * True when the pane is a stub awaiting lazy fetch — the schema is empty and
   * shouldn't be rendered. Host sets this to false once the real schema arrives.
   */
  loading?: boolean;
}

/** A single child resource shown in a group on the detail page */
export interface ChildResource {
  id: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  status?: StatusDotNode | undefined;
  subtitle?: string | undefined;
}

/** A group of child resources by type */
export interface ChildResourceGroup {
  typeId: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate: boolean;
  resources: ChildResource[];
}

export interface RerollSelection {
  kind: "output-ref";
  providerResourceId: string;
  providerPluginId: string;
  providerResourceTypeId: string;
  providerAccountId: string;
  providerOutputKey: string;
}

export interface ProviderResource {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  outputKey: string;
  pluginLogoSvg: string;
}
