import { z } from "zod";
import type {
  CredentialFormat,
  DetailViewSchema,
  FieldDefinition,
  MetricSeries,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { metricSeriesSchema } from "@infrawrench/plugin-base";
import {
  buildChildResourceGroups,
  formatErrorMessage,
  resourceTabTitle,
  toast,
  useUIStore,
  type ChildResource,
  type ChildResourceGroup,
  type PeerPaneData,
} from "@infrawrench/ui";
import {
  getCloudAccountDetail,
  getCloudResourceDetail,
  listCloudAccountResources,
  syncCloudAccountType,
  fetchCloudMetrics,
} from "../../../lib/cloud-api";
import type { LoaderParams } from "./types";

/** `POST /resources/:pluginId/:typeId/metrics` answers `{ series: [...] }`. */
const metricsResponseSchema = z.object({ series: z.array(metricSeriesSchema) });

export async function loadCloudResource(orgId: string, params: LoaderParams): Promise<void> {
  const {
    accountId,
    decodedResourceId,
    peerPlugin,
    peerType,
    peerParent,
    locationHash,
    isBackground,
    isCancelled,
    refs,
    setters,
    setAccountConnected,
    tabId,
  } = params;

  const accountDetail = await getCloudAccountDetail(orgId, accountId);
  if (!accountDetail) throw new Error("Account not found");

  let pluginId = accountDetail.account.pluginId;
  let resourceTypeId: string | null = null;

  if (peerPlugin && peerType) {
    pluginId = peerPlugin;
    resourceTypeId = peerType;
  } else {
    const topLevel = await listCloudAccountResources(orgId, accountId).catch(() => []);
    const topMatch = topLevel.find((r) => r.id === decodedResourceId);
    if (topMatch) {
      pluginId = topMatch.pluginId;
      resourceTypeId = topMatch.resourceTypeId;
    } else {
      for (const typeDef of accountDetail.resourceTypes) {
        const items = await syncCloudAccountType(orgId, accountId, typeDef.id).catch(() => []);
        const match = items.find((r) => r.id === decodedResourceId);
        if (match) {
          pluginId = match.pluginId;
          resourceTypeId = match.resourceTypeId;
          break;
        }
      }
    }
  }

  if (!resourceTypeId) throw new Error("Resource not found");

  const detail = (await getCloudResourceDetail(
    orgId,
    pluginId,
    resourceTypeId,
    decodedResourceId,
    accountId,
    peerParent,
    { includePeerPanes: false },
  )) as {
    detailSchema: DetailViewSchema;
    pluginLogoSvg: string;
    resourceDisplayName: string;
    resourceTypeLabel: string;
    resourceFields?: Record<string, string | number | boolean>;
    canDelete: boolean;
    canEdit?: boolean;
    editableFields?: Array<{
      key: string;
      label: string;
      kind: FieldDefinition["kind"];
      required: boolean;
      description?: string;
      enumValues?: string[];
    }>;
    credentialFormats?: CredentialFormat[];
    hasSqlEditor: boolean;
    hasKvConsole: boolean;
    kvDriverName?: string;
    hasDockerActions: boolean;
    sshHost: string | null;
    defaultSshUsername: string | null;
    supportsMetrics: boolean;
    childTypes: Array<{
      id: string;
      displayName: string;
      pluralDisplayName: string;
      supportsCreate: boolean;
      fields?: ResourceTypeDefinition["fields"];
    }>;
    childResources: ChildResource[];
    peerPanes: Array<{
      tabLabel: string;
      pluginLogoSvg: string;
      schema: PeerPaneData["schema"];
      peerPluginId: string;
    }>;
    peerIntegrationStubs?: Array<{
      tabLabel: string;
      pluginLogoSvg: string;
      peerPluginId: string;
    }>;
  };

  if (isCancelled()) return;

  const now = new Date().toISOString();
  const cloudResource: ResourceInstance = {
    id: decodedResourceId,
    pluginId,
    resourceTypeId,
    accountId,
    displayName: detail.resourceDisplayName,
    fields: detail.resourceFields ?? {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: now,
    updatedAt: now,
  };

  refs.cloudCtx.current = {
    orgId,
    pluginId,
    resourceTypeId,
    ...(peerParent ? { parentResourceId: peerParent } : {}),
  };
  refs.client.current = null;

  // Storage requires a local client until cloud storage endpoints land.
  const { storageBrowser: _storageBrowser, ...restSchema } = detail.detailSchema;
  void _storageBrowser;

  setters.setAccount({
    id: accountId,
    plugin_id: pluginId,
    display_name: accountDetail.account.displayName,
    encrypted_credentials: "",
    credentials_iv: "",
  });
  setters.setLogoSvg(detail.pluginLogoSvg);
  setters.setResource(cloudResource);
  setters.setResourceTypeLabel(detail.resourceTypeLabel);
  setters.setSchema(restSchema);
  setters.setCanDelete(detail.canDelete);
  setters.setCanEdit(detail.canEdit ?? false);
  setters.setEditableFields(
    (detail.editableFields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: f.required,
      ...(f.description ? { description: f.description } : {}),
      ...(f.enumValues ? { enumValues: f.enumValues } : {}),
    })),
  );
  setters.setCredentialFormats(detail.credentialFormats ?? []);
  setters.setSshHost(detail.sshHost);
  setters.setSshDefaultUsername(detail.defaultSshUsername);
  setters.setPgConnected(detail.hasSqlEditor);
  setters.setIsKvPlugin(detail.hasKvConsole);
  setters.setKvDriverName(detail.kvDriverName ?? null);
  setters.setKvConnected(detail.hasKvConsole);
  setters.setIsDockerPlugin(detail.hasDockerActions);
  setters.setDockerDriverName(null);
  setters.setChildResourceGroups(
    buildChildResourceGroups(
      detail.childTypes.map((ct) => ({
        id: ct.id,
        displayName: ct.displayName,
        pluralDisplayName: ct.pluralDisplayName,
        supportsCreate: ct.supportsCreate,
        ...(ct.fields ? { fields: ct.fields } : {}),
      })) as ResourceTypeDefinition[],
      detail.childResources,
    ) as ChildResourceGroup[],
  );

  // Stubs on first load; hydrate lazily on tab open. Preserve hydrated panes
  // across background refreshes.
  const stubs = detail.peerIntegrationStubs ?? [];
  const eagerPanes = detail.peerPanes ?? [];
  if (eagerPanes.length > 0) {
    setters.setPeerPanes(
      eagerPanes.map((p) => ({
        tabLabel: p.tabLabel,
        pluginLogoSvg: p.pluginLogoSvg,
        credentials: {},
        schema: p.schema,
      })),
    );
  } else if (isBackground) {
    setters.setPeerPanes((prev) => {
      if (prev.length > 0) return prev;
      return stubs.map((s) => ({
        tabLabel: s.tabLabel,
        pluginLogoSvg: s.pluginLogoSvg,
        credentials: {},
        schema: { resourceGroups: [] },
        loading: true,
      }));
    });
  } else {
    setters.setPeerPanes(
      stubs.map((s) => ({
        tabLabel: s.tabLabel,
        pluginLogoSvg: s.pluginLogoSvg,
        credentials: {},
        schema: { resourceGroups: [] },
        loading: true,
      })),
    );
  }

  if (tabId) {
    const viewSuffix = resourceTabTitle(detail.resourceDisplayName, locationHash);
    useUIStore.getState().setWorkspaceTabTitle(tabId, viewSuffix);
  }

  setAccountConnected(accountId, true);

  if (detail.supportsMetrics && !isBackground) {
    fetchCloudMetrics(orgId, pluginId, resourceTypeId, {
      accountId,
      resourceId: decodedResourceId,
    })
      .then((res) => {
        if (!isCancelled())
          setters.setMetricSeries(metricsResponseSchema.parse(res).series as MetricSeries[]);
      })
      .catch((err) => {
        if (!isCancelled()) toast.error(`Couldn't load metrics: ${formatErrorMessage(err)}`);
      });
  }
}
