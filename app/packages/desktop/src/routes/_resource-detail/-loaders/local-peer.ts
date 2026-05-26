import { resourceTabTitle, useUIStore } from "@infrawrench/ui";
import { getDb } from "../../../db/client";
import type { AccountRow } from "../../../db/rows";
import { invoke } from "../../../lib/invoke";
import { getPlugin } from "../../../plugins/loader";
import { buildPluginHostServices } from "../../../lib/sql-drivers";
import type { LoaderParams } from "./types";

export async function loadLocalPeerResource(params: LoaderParams): Promise<void> {
  const {
    accountId,
    decodedResourceId,
    peerPlugin,
    peerType,
    peerParent,
    locationHash,
    isCancelled,
    refs,
    setters,
    setAccountConnected,
    tabId,
  } = params;

  const db = await getDb();
  const accountRows = await db.select<AccountRow[]>(
    "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
    [accountId],
  );
  const accountRow = accountRows[0];
  if (!accountRow) throw new Error("Account not found");

  const parentCredentials = await invoke<Record<string, string>>("account_get_credentials", {
    accountId: accountRow.id,
  });

  const parentLoaded = await getPlugin(accountRow.plugin_id);
  if (!parentLoaded) throw new Error(`Plugin "${accountRow.plugin_id}" not loaded`);

  const parentHostServices = buildPluginHostServices(
    parentLoaded.plugin.manifest,
    parentCredentials,
  );
  const parentClient = parentLoaded.plugin.createClient(parentCredentials, parentHostServices);

  const parentTypeId = peerParent!.split(":")[1];
  if (!parentTypeId) throw new Error("Cannot parse parent resource type");

  const parentTypeDef = parentLoaded.plugin.resourceTypes.find((t) => t.id === parentTypeId);
  const integration = parentTypeDef?.peerIntegrations?.find((i) => i.pluginId === peerPlugin);
  if (!integration) throw new Error(`No peer integration for ${peerPlugin}`);

  const peerCredentials: Record<string, string> = {};
  for (const mapping of integration.credentialMappings) {
    const value = await parentClient.resolveOutput(
      parentTypeId,
      peerParent!,
      mapping.outputKey,
      accountId,
    );
    peerCredentials[mapping.credentialKey] = value;
  }

  const peerLoaded = await getPlugin(peerPlugin!);
  if (!peerLoaded) throw new Error(`Plugin "${peerPlugin}" not loaded`);
  const peerHostServices = buildPluginHostServices(peerLoaded.plugin.manifest, peerCredentials);
  const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerHostServices);
  refs.client.current = peerClient;

  const peerResources = await peerClient.listResources(peerType!, accountId);
  const found = peerResources.find((r) => r.id === decodedResourceId);
  if (!found) throw new Error("Resource not found");

  if (isCancelled()) return;

  const peerTypeDef = peerLoaded.plugin.resourceTypes.find((t) => t.id === peerType);
  let detailSchema = peerClient.renderDetail(found);

  const peerKvDriver = peerLoaded.plugin.manifest.kvDriver;
  const peerKvConnectionString = peerKvDriver
    ? (peerCredentials[peerKvDriver.credentialKey] ?? "")
    : "";

  const peerSqlDriver = peerLoaded.plugin.manifest.sqlDriver;
  const peerSqlConnectionString = peerSqlDriver
    ? (peerCredentials[peerSqlDriver.credentialKey] ?? "")
    : "";

  if (peerSqlConnectionString && peerSqlDriver) {
    refs.connectionString.current = peerSqlConnectionString;
    refs.sqlDriverId.current = peerSqlDriver.driver;
  } else {
    refs.connectionString.current = peerKvConnectionString;
  }

  let sqlReady = false;
  if (peerSqlConnectionString && peerSqlDriver) {
    try {
      const tables = (await peerClient.introspect?.()) ?? [];
      if (detailSchema.sqlEditor) {
        detailSchema = {
          ...detailSchema,
          sqlEditor: { ...detailSchema.sqlEditor, tables },
        };
      }
      sqlReady = true;
    } catch {
      // Introspection failed — still enable the editor; the user's first query will surface the real error.
      sqlReady = true;
    }
  }

  setters.setAccount(accountRow);
  setters.setLogoSvg(peerLoaded.plugin.manifest.logoSvg);
  setters.setResource(found);
  setters.setResourceTypeLabel(peerTypeDef?.displayName ?? "Resource");
  setters.setSchema(detailSchema);
  setters.setCanDelete(!!peerClient.deleteResource);
  const peerCanEdit = !!peerClient.updateResource && !!peerTypeDef?.supportsUpdate;
  setters.setCanEdit(peerCanEdit);
  setters.setEditableFields(peerCanEdit ? (peerTypeDef?.fields ?? []) : []);
  setters.setSshHost(null);
  setters.setSshDefaultUsername(null);
  setters.setPgConnected(sqlReady);
  setters.setIsKvPlugin(!!peerKvDriver);
  setters.setKvDriverName(peerKvDriver?.driver ?? null);
  setters.setKvConnected(!!peerKvConnectionString);
  setters.setIsDockerPlugin(false);
  setters.setDockerDriverName(null);
  setters.setChildResourceGroups([]);
  setters.setPeerPanes([]);
  refs.localPeerCtx.current = null;
  refs.peerParentReroll.current = async (outputKey: string) => {
    const mapping = integration.credentialMappings.find((m) => m.credentialKey === outputKey);
    if (!mapping) {
      throw new Error(`No parent output mapped to credential "${outputKey}"`);
    }
    if (!parentClient.rerollOutput) {
      throw new Error(
        `${parentLoaded.plugin.manifest.displayName} does not support rerolling outputs`,
      );
    }
    await parentClient.rerollOutput(parentTypeId, peerParent!, mapping.outputKey, accountId);
  };
  setAccountConnected(accountId, true);

  if (tabId) {
    const viewSuffix = resourceTabTitle(found.displayName, locationHash);
    useUIStore.getState().setWorkspaceTabTitle(tabId, viewSuffix);
  }
}
