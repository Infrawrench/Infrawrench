/**
 * Public status pages — cloud-mode only, like the probes they publish. One
 * wrapper per allowlisted IPC channel, matching `cloud-probes.ts`.
 */
import type {
  StatusPage,
  StatusPageCreate,
  StatusPageListResponse,
  StatusPagePatch,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";

export async function listCloudStatusPages(orgId: string): Promise<StatusPageListResponse> {
  return invoke("cloud_status_pages_list", { orgId });
}

export async function createCloudStatusPage(
  orgId: string,
  input: StatusPageCreate,
): Promise<StatusPage> {
  return invoke("cloud_status_pages_create", { orgId, input });
}

export async function updateCloudStatusPage(
  orgId: string,
  pageId: string,
  patch: StatusPagePatch,
): Promise<StatusPage> {
  return invoke("cloud_status_pages_update", { orgId, pageId, patch });
}

export async function rotateCloudStatusPageSlug(
  orgId: string,
  pageId: string,
): Promise<StatusPage> {
  return invoke("cloud_status_pages_rotate_slug", { orgId, pageId });
}

export async function deleteCloudStatusPage(orgId: string, pageId: string): Promise<void> {
  await invoke("cloud_status_pages_delete", { orgId, pageId });
}

export async function attachCloudStatusPageHostname(
  orgId: string,
  pageId: string,
  hostname: string,
): Promise<StatusPage> {
  return invoke("cloud_status_pages_attach_hostname", { orgId, pageId, hostname });
}

export async function refreshCloudStatusPageHostname(
  orgId: string,
  pageId: string,
): Promise<StatusPage> {
  return invoke("cloud_status_pages_refresh_hostname", { orgId, pageId });
}

export async function detachCloudStatusPageHostname(
  orgId: string,
  pageId: string,
): Promise<StatusPage> {
  return invoke("cloud_status_pages_detach_hostname", { orgId, pageId });
}
