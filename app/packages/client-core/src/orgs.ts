import type { CloudFetch } from "./fetch";

export interface CloudOrg {
  id: string;
  displayName: string;
  role: string;
}

export interface CloudMe {
  userId: string;
  email: string | null;
  needsOnboarding: boolean;
}

/**
 * `init` exists so callers on a launch path can pass an abort signal — this
 * call gates the app's first screen, and a request that hangs rather than
 * fails would strand it on a spinner.
 */
export async function fetchOrgs(api: CloudFetch, init?: RequestInit): Promise<CloudOrg[]> {
  return (await api.api<CloudOrg[]>("/api/auth/orgs", init)) ?? [];
}

export async function fetchMe(api: CloudFetch): Promise<CloudMe | null> {
  return api.api<CloudMe>("/api/auth/me");
}
