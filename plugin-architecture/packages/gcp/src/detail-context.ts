/**
 * Shared context object passed to every GCP detail renderer.
 *
 * Lives in its own file so per-service renderer modules can import it
 * without creating a cycle through the `detail-renderers.ts` dispatcher.
 * `detail-renderers.ts` re-exports `GcpDetailContext` from here so existing
 * consumers (e.g. `client.ts`) keep working.
 */
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export interface GcpDetailContext {
  id(accountId: string, typeId: string, externalId: string): string;
  project: string;
  resourceTypes: ResourceTypeDefinition[];
}
