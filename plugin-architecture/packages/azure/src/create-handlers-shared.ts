import type { Client as GraphClient } from "@microsoft/microsoft-graph-client";
import type { AzureHttpTransport } from "./http.js";

export const ARM = "https://management.azure.com";

export interface AzureCreateContext extends AzureHttpTransport {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  patch<T>(url: string, body: unknown): Promise<T>;
  del(url: string): Promise<void>;
  makeId(accountId: string, typeId: string, externalId: string): string;
  graphClient: GraphClient;
  subscriptionId: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export async function fetchResourceGroups(ctx: AzureCreateContext) {
  const rgs = await ctx.get<{ value: Array<{ name: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups?api-version=2022-09-01`,
  );
  return (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
}
