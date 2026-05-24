import type { SecretVersion } from "@infrawrench/plugin-base";
import { invoke } from "./invoke";

export async function listCloudSecretVersions(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<{ versions: SecretVersion[] }> {
  return invoke("cloud_list_secret_versions", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    parentResourceId,
  });
}

export async function accessCloudSecretVersion(
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
  return invoke("cloud_access_secret_version", { orgId, pluginId, resourceTypeId, body });
}

export async function addCloudSecretVersion(
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
  return invoke("cloud_add_secret_version", { orgId, pluginId, resourceTypeId, body });
}

export async function modifyCloudSecretVersion(
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
  return invoke("cloud_modify_secret_version", { orgId, pluginId, resourceTypeId, body });
}
