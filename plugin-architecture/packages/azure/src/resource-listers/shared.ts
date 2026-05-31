import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ListerContext {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  del(url: string): Promise<void>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  subscriptionId: string;
}

export type { ResourceInstance };

export const ARM = "https://management.azure.com";

/** Helper to extract resource group name from a full Azure resource ID */
export function extractResourceGroup(azureId: string): string {
  const match = azureId.match(/resourceGroups\/([^/]+)/i);
  return match?.[1] ?? "";
}

/** Helper to extract a name from a full Azure resource ID */
export function extractName(azureId: string): string {
  return azureId.split("/").pop() ?? "";
}
