import { invoke } from "./invoke";

export interface CloudOrg {
  id: string;
  displayName: string;
  role: string;
}

export async function getCloudAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
}> {
  return invoke("cloud_auth_status");
}

export async function startCloudAuth(): Promise<void> {
  await invoke("cloud_auth_start");
}

export async function cloudLogout(): Promise<void> {
  await invoke("cloud_auth_logout");
}

export async function getCloudOrgs(): Promise<CloudOrg[]> {
  return invoke("cloud_auth_orgs");
}
