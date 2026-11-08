/**
 * Cloud custom graphs. Cloud-mode only: the script runs in the web server's
 * sandbox against org data, so local mode never shows these. Typed calls to
 * the contract's `customGraphs` domain over the cloud transport
 * (`./cloud-client.ts`), matching `cloud-probes.ts`.
 *
 * Typings come from the server: the `graph.*` half is static but the
 * appended read-only `infra.*` half reflects the org's connected accounts.
 * They are a text answer, which the transport does not read yet, so they
 * still travel on their own IPC channel.
 */
import type {
  CustomGraphCheckResult,
  CustomGraphsClient,
  CustomGraphDetail,
  CustomGraphRenderRequest,
  CustomGraphRenderResult,
  CustomGraphSummary,
} from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const customGraphs = () => cloudClient("customGraphs").customGraphs;

/**
 * The render request as the endpoint takes it: client-core allows each field
 * to be explicitly `undefined`, which the schema refuses, so only the fields
 * that are set are sent (what `JSON.stringify` sent before).
 */
function renderPayload(request: CustomGraphRenderRequest) {
  return {
    ...(request.controls !== undefined ? { controls: request.controls } : {}),
    ...(request.button !== undefined ? { button: request.button } : {}),
    ...(request.trigger !== undefined ? { trigger: request.trigger } : {}),
  };
}

export function createCloudCustomGraphsClient(orgId: string): CustomGraphsClient {
  return {
    list: (): Promise<CustomGraphSummary[]> => runRpc(customGraphs().list({ params: { orgId } })),
    get: (graphId): Promise<CustomGraphDetail> =>
      runRpc(customGraphs().get({ params: { orgId, id: graphId } })),
    render: (graphId, request: CustomGraphRenderRequest): Promise<CustomGraphRenderResult> =>
      runRpc(
        customGraphs().render({ params: { orgId, id: graphId }, payload: renderPayload(request) }),
      ),
    create: (body): Promise<CustomGraphDetail> =>
      runRpc(customGraphs().create({ params: { orgId }, payload: body })),
    update: (graphId, body): Promise<CustomGraphDetail> =>
      runRpc(customGraphs().update({ params: { orgId, id: graphId }, payload: body })),
    remove: async (graphId) => {
      await runRpc(customGraphs().delete({ params: { orgId, id: graphId } }));
    },
    check: (source): Promise<CustomGraphCheckResult> =>
      runRpc(customGraphs().check({ params: { orgId }, payload: { source } })),
    typings: () => runRpc(customGraphs().typings({ params: { orgId } })),
  };
}
