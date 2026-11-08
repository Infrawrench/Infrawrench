import { useUIStore } from "@infrawrench/ui";
import type { ResourceReportsClient } from "@infrawrench/ui/resource-reports";
import type { ResourceReportInput, ResourceReportQueryRequest } from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { invoke } from "./invoke";
import { runRpc } from "./rpc/client";
import { createCloudCostReportFolder } from "./cloud-costs";
import { createDesktopSharingClient } from "./cost-reports-client";

/**
 * Resource reports are cloud-only: the rows are a server-side join of the
 * synced inventory with the cost store. The active org is resolved at call
 * time, not closed over, because the org can change under a mounted panel.
 * Every method is offered; the server enforces `resources:write` and
 * `costs:write` (folders) and the panel shows its error. Typed calls to the
 * contract's `resourceReports` domain over the cloud transport
 * (`./cloud-client.ts`), the CSV export apart.
 */
const reports = () => cloudClient("resourceReports").resourceReports;

/** The bodies the endpoints take: optional keys the editor leaves `undefined` are dropped. */
function reportPayload(input: ResourceReportInput) {
  return {
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    config: input.config,
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
  };
}

function queryPayload(request: ResourceReportQueryRequest) {
  return {
    config: request.config,
    ...(request.offset !== undefined ? { offset: request.offset } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  };
}

function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Resource reports require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopResourceReportsClient(): ResourceReportsClient {
  return {
    sharing: createDesktopSharingClient(),
    listReports: () => runRpc(reports().list({ params: { orgId: requireOrgId() } })),
    getReport: (reportId) =>
      runRpc(reports().get({ params: { orgId: requireOrgId(), id: reportId } })),
    listFolders: () => runRpc(reports().folders({ params: { orgId: requireOrgId() } })),
    getOptions: (types) => {
      const joined = (types ?? []).map((t) => `${t.pluginId}/${t.resourceTypeId}`).join(",");
      return runRpc(
        reports().options({
          params: { orgId: requireOrgId() },
          query: joined ? { types: joined } : {},
        }),
      );
    },
    getTagValues: async (source, key) =>
      (
        await runRpc(
          reports().tagValues({ params: { orgId: requireOrgId() }, query: { source, key } }),
        )
      ).values,
    query: (request) =>
      runRpc(
        reports().query({ params: { orgId: requireOrgId() }, payload: queryPayload(request) }),
      ),
    // CSV is text, not JSON; it stays on its own channel until the transport reads text.
    exportCsv: (config, name) =>
      invoke<string>("cloud_resource_reports_csv", { orgId: requireOrgId(), config, name }),
    createReport: (input) =>
      runRpc(
        reports().create({ params: { orgId: requireOrgId() }, payload: reportPayload(input) }),
      ),
    updateReport: (reportId, input) =>
      runRpc(
        reports().update({
          params: { orgId: requireOrgId(), id: reportId },
          payload: reportPayload(input),
        }),
      ),
    deleteReport: async (reportId) => {
      await runRpc(reports().delete({ params: { orgId: requireOrgId(), id: reportId } }));
    },
    createFolder: (input) => createCloudCostReportFolder(requireOrgId(), input),
  };
}
