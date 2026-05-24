import type { OrgEntry } from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * A cloud-managed organization visible to the desktop user.
 * Structurally identical to {@link OrgEntry} from the shared UI package —
 * re-exported here so callers can import from `./cloud-api` if they prefer.
 */
export type CloudOrg = OrgEntry;

export async function getCloudAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
}> {
  return invoke("cloud_auth_status");
}

export async function startCloudAuth(): Promise<void> {
  await invoke("cloud_auth_start");
}

export async function getCloudOrgs(): Promise<CloudOrg[]> {
  return invoke("cloud_auth_orgs");
}
