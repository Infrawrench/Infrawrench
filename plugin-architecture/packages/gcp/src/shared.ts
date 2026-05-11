import type { HostServices, ResourceInstance } from "@infrawrench/plugin-base";
import type { ServiceAccountKey } from "./auth.js";

/**
 * Shared call surface that the various per-service handler modules need to
 * perform GCP API calls. `GcpClient` provides the concrete implementation;
 * each handler module is a free function taking this context.
 *
 * Keeping the surface narrow (just `get`, `paginate`, `token`, `project`,
 * `hostServices`, plus `getResource`) lets handlers be tested with simple
 * fakes and prevents the accidental coupling that the previous god-class
 * encouraged.
 */
export interface GcpClientContext {
  readonly project: string;
  readonly serviceAccountKey: ServiceAccountKey;
  readonly hostServices: HostServices | undefined;
  token(): Promise<string>;
  get<T>(url: string): Promise<T>;
  paginate<T>(baseUrl: string, key: string, params?: Record<string, string>): Promise<T[]>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
}
