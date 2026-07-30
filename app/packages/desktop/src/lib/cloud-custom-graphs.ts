/**
 * Cloud custom graphs. Cloud-mode only — the script runs in the web server's
 * sandbox against org data, so local mode never shows these. The ambient
 * `graph.d.ts` is static and comes straight from the runtime package rather
 * than a round-trip to the server.
 */
import { generateGraphDts } from "@infrawrench/workflow-runtime/client";
import type {
  CustomGraphCheckResult,
  CustomGraphsClient,
  CustomGraphDetail,
  CustomGraphRenderRequest,
  CustomGraphRenderResult,
  CustomGraphSummary,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

export function createCloudCustomGraphsClient(orgId: string): CustomGraphsClient {
  return {
    list: () => invoke<CustomGraphSummary[]>("cloud_list_custom_graphs", { orgId }),
    get: (graphId) => invoke<CustomGraphDetail>("cloud_get_custom_graph", { orgId, graphId }),
    render: (graphId, request: CustomGraphRenderRequest) =>
      invoke<CustomGraphRenderResult>("cloud_render_custom_graph", { orgId, graphId, request }),
    create: (body) => invoke<CustomGraphDetail>("cloud_create_custom_graph", { orgId, body }),
    update: (graphId, body) =>
      invoke<CustomGraphDetail>("cloud_update_custom_graph", { orgId, graphId, body }),
    remove: async (graphId) => {
      await invoke("cloud_delete_custom_graph", { orgId, graphId });
    },
    check: (source) =>
      invoke<CustomGraphCheckResult>("cloud_check_custom_graph", { orgId, source }),
    typings: () => Promise.resolve(generateGraphDts()),
  };
}
