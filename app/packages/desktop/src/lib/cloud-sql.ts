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
