/**
 * Versioned secrets on a cloud account's resource: typed calls to the
 * contract's `resources` domain over the cloud transport (`./cloud-client.ts`).
 */
import type { SecretVersion } from "@infrawrench/plugin-base";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const resources = () => cloudClient("resources").resources;

export function listCloudSecretVersions(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<{ versions: SecretVersion[] }> {
  return runRpc(
    resources().listSecretVersions({
      params: { orgId, pluginId, typeId: resourceTypeId },
      query: { resourceId, accountId, ...(parentResourceId ? { parentResourceId } : {}) },
    }),
  );
}

export function accessCloudSecretVersion(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    versionId: string;
    parentResourceId?: string;
  },
): Promise<{ value: string }> {
  return runRpc(
    resources().accessSecretVersion({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: body,
    }),
  );
}

export function addCloudSecretVersion(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    value: string;
    parentResourceId?: string;
  },
): Promise<{ version: SecretVersion }> {
  return runRpc(
    resources().addSecretVersion({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: body,
    }),
  );
}

export function modifyCloudSecretVersion(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    versionId: string;
    action: "enable" | "disable" | "destroy";
    parentResourceId?: string;
  },
): Promise<{ version: SecretVersion }> {
  return runRpc(
    resources().modifySecretVersion({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: body,
    }),
  );
}
