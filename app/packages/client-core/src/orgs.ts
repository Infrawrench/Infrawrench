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

export async function fetchOrgs(api: CloudFetch): Promise<CloudOrg[]> {
  return (await api.api<CloudOrg[]>("/api/auth/orgs")) ?? [];
}

export async function fetchMe(api: CloudFetch): Promise<CloudMe | null> {
  return api.api<CloudMe>("/api/auth/me");
}
