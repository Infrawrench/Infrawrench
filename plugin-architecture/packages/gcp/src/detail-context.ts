/**
 * Shared context object passed to every GCP detail renderer.
 *
 * Lives in its own file so per-service renderer modules can import it
 * without creating a cycle through the `detail-renderers.ts` dispatcher.
 */
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export interface GcpDetailContext {
  id(accountId: string, typeId: string, externalId: string): string;
  project: string;
  resourceTypes: ResourceTypeDefinition[];
}
