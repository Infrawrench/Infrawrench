import type {
  CredentialFormat,
  DetailViewSchema,
  FieldDefinition,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import type { PeerPaneData, ChildResourceGroup } from "@infrawrench/ui";
import type { AccountRow } from "../../../db/rows";
import type { CloudCtx, SshConfig } from "../-types";

export interface LoaderRefs {
  connectionString: { current: string };
  sqlDriverId: { current: string };
  client: { current: PluginClient | null };
  cloudCtx: { current: CloudCtx | null };
  dockerHost: { current: string };
  localPeerCtx: {
    current: {
      peerIntegrations: ResourceTypeDefinition["peerIntegrations"];
      parentPluginId: string;
      parentResourceTypeId: string;
      parentResourceId: string;
      /** Live fields/outputs of the parent resource. Passed to credential
       * rewriters so they can read e.g. `connectionName` without re-fetching. */
      parentResourceFields: Record<string, unknown>;
      parentResourceOutputs: Record<string, unknown>;
    } | null;
  };
  /**
   * Set in peer-pane mode to a closure that delegates a reroll request back
   * to the parent — maps the child's credentialKey to the parent output key
   * via the integration's credentialMappings and calls `parentClient.rerollOutput`.
   * Cleared on every navigation; null in non-peer mode.
   */
  peerParentReroll: {
    current: ((outputKey: string) => Promise<void>) | null;
  };
}

export interface LoaderSetters {
  setAccount: (a: AccountRow | null) => void;
  setResource: (r: ResourceInstance | null) => void;
  setSchema: (s: DetailViewSchema | null) => void;
  setLogoSvg: (s: string) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setPgConnected: (b: boolean) => void;
  setPgError: (e: string | null) => void;
  setKvConnected: (b: boolean) => void;
  setIsKvPlugin: (b: boolean) => void;
  setKvDriverName: (s: string | null) => void;
  setIsDockerPlugin: (b: boolean) => void;
  setDockerDriverName: (s: string | null) => void;
  setHasStorageToken: (b: boolean) => void;
  setSshConfig: (c: SshConfig | null) => void;
  setSshHost: (s: string | null) => void;
  setSshDefaultUsername: (s: string | null) => void;
  setRdpHost: (s: string | null) => void;
  setRdpDefaultUsername: (s: string | null) => void;
  setCanDelete: (b: boolean) => void;
  setCanEdit: (b: boolean) => void;
  setEditableFields: (f: FieldDefinition[]) => void;
  setCredentialFormats: (f: CredentialFormat[]) => void;
  setResourceTypeLabel: (s: string) => void;
  setPeerPanes: (v: PeerPaneData[] | ((prev: PeerPaneData[]) => PeerPaneData[])) => void;
  setChildResourceGroups: (g: ChildResourceGroup[]) => void;
  setMetricSeries: (m: MetricSeries[] | undefined) => void;
}

export interface LoaderParams {
  accountId: string;
  decodedResourceId: string;
  peerPlugin: string | undefined;
  peerType: string | undefined;
  peerParent: string | undefined;
  locationHash: string;
  isBackground: boolean;
  isCancelled: () => boolean;
  refs: LoaderRefs;
  setters: LoaderSetters;
  setAccountConnected: (accountId: string, connected: boolean) => void;
  /** Id of the workspace tab the loader is feeding. Used to update the
   * correct tab's title — with keep-alive, multiple tabs are mounted
   * simultaneously and `activeWorkspaceTabId` would target the wrong one. */
  tabId: string | null;
}
