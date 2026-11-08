import { useUIStore } from "@infrawrench/ui";
import type { DoraClient } from "@infrawrench/ui/dora";
import type {
  DoraChangesResponse,
  DoraQuery,
  DoraReport,
  DoraRestoresResponse,
  DoraSettingsView,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const dora = () => cloudClient("dora").dora;

/**
 * The window and scope filter every DORA read takes, as `doraQueryString`
 * builds them: `value` only alongside `dimension`.
 */
function windowQuery(q: DoraQuery) {
  return {
    from: q.from,
    to: q.to,
    ...(q.dimension ? { dimension: q.dimension, ...(q.value ? { value: q.value } : {}) } : {}),
  };
}

/**
 * Delivery (DORA metrics) is cloud-only: the deploy events and incidents live
 * in the cloud. The active org is resolved at call time rather than closed
 * over, matching `slos-client.ts`. The settings writer is always offered; the
 * server enforces `org:settings:write` and the modal shows its error.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Delivery metrics require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopDoraClient(): DoraClient {
  return {
    getReport: (q): Promise<DoraReport> =>
      runRpc(
        dora().report({
          params: { orgId: requireOrgId() },
          query: {
            ...windowQuery(q),
            ...(q.groupBy ? { groupBy: q.groupBy } : {}),
            ...(q.bucket ? { bucket: q.bucket } : {}),
          },
        }),
      ),
    listChanges: (q): Promise<DoraChangesResponse> =>
      runRpc(
        dora().changes({
          params: { orgId: requireOrgId() },
          query: { ...windowQuery(q), ...(q.failedOnly ? { failedOnly: "true" } : {}) },
        }),
      ),
    listRestores: (q): Promise<DoraRestoresResponse> =>
      runRpc(dora().restores({ params: { orgId: requireOrgId() }, query: windowQuery(q) })),
    getSettings: (): Promise<DoraSettingsView> =>
      runRpc(dora().settings({ params: { orgId: requireOrgId() } })),
    updateSettings: (patch): Promise<DoraSettingsView> =>
      runRpc(dora().updateSettings({ params: { orgId: requireOrgId() }, payload: patch })),
  };
}
