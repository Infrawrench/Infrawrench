/**
 * SQL, KV and artifact-registry calls against a cloud org's live resources:
 * typed calls to the contract's `connections` group over the cloud transport
 * (`./cloud-client.ts`). The panels read the plugin's native result shapes,
 * so each answer is handed on as the server sent it.
 */
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const connections = () => cloudClient("connections").connections;

export async function cloudSqlQuery(
  orgId: string,
  body: { accountId: string; resourceId?: string; resourceTypeId?: string; sql: string },
): Promise<unknown> {
  return runRpc(connections().sqlQuery({ params: { orgId }, payload: body }));
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
  return runRpc(connections().artifactsList({ params: { orgId }, payload: body }));
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
  return runRpc(connections().sqlExecute({ params: { orgId }, payload: body }));
}

export async function cloudSqlEstimate(
  orgId: string,
  body: { accountId: string; resourceId: string; sql: string },
): Promise<unknown> {
  return runRpc(connections().sqlEstimate({ params: { orgId }, payload: body }));
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
  return runRpc(connections().kvCommand({ params: { orgId }, payload: body }));
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
  return runRpc(connections().kvBrowserList({ params: { orgId }, payload: body }));
}

export async function cloudKvBrowserGet(
  orgId: string,
  body: { accountId: string; resourceTypeId: string; resourceId: string; key: string },
): Promise<unknown> {
  return runRpc(connections().kvBrowserGet({ params: { orgId }, payload: body }));
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
  return runRpc(connections().kvBrowserPut({ params: { orgId }, payload: body }));
}

export async function cloudKvBrowserDelete(
  orgId: string,
  body: { accountId: string; resourceTypeId: string; resourceId: string; key: string },
): Promise<unknown> {
  return runRpc(connections().kvBrowserDelete({ params: { orgId }, payload: body }));
}
