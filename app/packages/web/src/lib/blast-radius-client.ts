import type { BlastRadiusClient } from "@infrawrench/ui";
import type { BlastRadiusReport } from "@infrawrench/client-core";
import { apiGet } from "./api";

/** Web implementation of the blast-radius surfaces' host-injected data access. */
export function createWebBlastRadiusClient(orgId: string): BlastRadiusClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/blast-radius`;
  return {
    getBlastRadius: (resourceId: string) =>
      apiGet<BlastRadiusReport>(`${base}?resourceId=${encodeURIComponent(resourceId)}`),
  };
}
