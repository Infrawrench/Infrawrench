/**
 * Public status pages: cloud-mode only, like the probes they publish. Typed
 * calls to the contract's `statusPages` domain over the cloud transport
 * (`./cloud-client.ts`), matching `cloud-probes.ts`.
 */
import type {
  StatusPage,
  StatusPageCreate,
  StatusPageListResponse,
  StatusPagePatch,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const statusPages = () => cloudClient("statusPages").statusPages;

export async function listCloudStatusPages(orgId: string): Promise<StatusPageListResponse> {
  return runRpc(statusPages().list({ params: { orgId } }));
}

export async function createCloudStatusPage(
  orgId: string,
  input: StatusPageCreate,
): Promise<StatusPage> {
  return runRpc(statusPages().create({ params: { orgId }, payload: input }));
}

export async function updateCloudStatusPage(
  orgId: string,
  pageId: string,
  patch: StatusPagePatch,
): Promise<StatusPage> {
  return runRpc(statusPages().update({ params: { orgId, id: pageId }, payload: patch }));
}

export async function rotateCloudStatusPageSlug(
  orgId: string,
  pageId: string,
): Promise<StatusPage> {
  return runRpc(statusPages().rotateSlug({ params: { orgId, id: pageId } }));
}

export async function deleteCloudStatusPage(orgId: string, pageId: string): Promise<void> {
  await runRpc(statusPages().delete({ params: { orgId, id: pageId } }));
}
