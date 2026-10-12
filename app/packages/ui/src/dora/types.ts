// The wire types come from `@infrawrench/client-core`; this module only adds
// the client seam a host must provide.
import type {
  DoraChangesResponse,
  DoraQuery,
  DoraReport,
  DoraRestoresResponse,
  DoraSettings,
  DoraSettingsView,
} from "@infrawrench/client-core";

/**
 * What a host provides for the Delivery panel. `updateSettings` is optional:
 * without it the settings render read-only (it takes `org:settings:write`,
 * while the metrics only take `deployments:read`).
 */
export interface DoraClient {
  getReport(query: DoraQuery): Promise<DoraReport>;
  listChanges(query: DoraQuery): Promise<DoraChangesResponse>;
  listRestores(query: DoraQuery): Promise<DoraRestoresResponse>;
  getSettings(): Promise<DoraSettingsView>;
  updateSettings?(patch: Partial<DoraSettings>): Promise<DoraSettingsView>;
}
