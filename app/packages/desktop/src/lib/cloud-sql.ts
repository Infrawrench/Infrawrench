import { invoke } from "./invoke";

export async function cloudSqlQuery(
  orgId: string,
  body: { accountId: string; resourceId?: string; resourceTypeId?: string; sql: string },
): Promise<unknown> {
  return invoke("cloud_sql_query", { orgId, body });
}

export async function cloudListArtifacts(
  orgId: string,
  body: {
    accountId: string;
    resourceId: string;
    resourceTypeId: string;
    pageToken?: string;
    prefix?: string;
  },
): Promise<unknown> {
  return invoke("cloud_list_artifacts", { orgId, body });
}

export async function cloudSqlExecute(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    sql: string;
    params?: unknown[];
  },
): Promise<unknown> {
  return invoke("cloud_sql_execute", { orgId, body });
}

export async function cloudSqlEstimate(
  orgId: string,
  body: { accountId: string; resourceId: string; sql: string },
): Promise<unknown> {
  return invoke("cloud_sql_estimate", { orgId, body });
}

export async function cloudKvCommand(
  orgId: string,
  body: {
    accountId: string;
    command: string;
    args: (string | number)[];
    pluginId?: string;
    parentResourceId?: string;
  },
): Promise<unknown> {
  return invoke("cloud_kv_command", { orgId, body });
}

export async function cloudKvBrowserList(
  orgId: string,
  body: {
    accountId: string;
    resourceTypeId: string;
    resourceId: string;
    prefix?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<unknown> {
  return invoke("cloud_kv_browser_list", { orgId, body });
}

export async function cloudKvBrowserGet(
  orgId: string,
  body: { accountId: string; resourceTypeId: string; resourceId: string; key: string },
): Promise<unknown> {
  return invoke("cloud_kv_browser_get", { orgId, body });
}

export async function cloudKvBrowserPut(
  orgId: string,
  body: {
    accountId: string;
    resourceTypeId: string;
    resourceId: string;
    key: string;
    value: string;
  },
): Promise<unknown> {
  return invoke("cloud_kv_browser_put", { orgId, body });
}

export async function cloudKvBrowserDelete(
  orgId: string,
  body: { accountId: string; resourceTypeId: string; resourceId: string; key: string },
): Promise<unknown> {
  return invoke("cloud_kv_browser_delete", { orgId, body });
}
