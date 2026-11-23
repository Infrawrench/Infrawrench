import type { ResourceRunwayResponse, RunwayListResponse } from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

/**
 * Capacity runway reads for the desktop: the org-wide list on the Quotas tab
 * and one resource's charts on its Metrics tab. Cloud-only, like the quota
 * radar: the readings are recorded by the cloud sync, which the desktop does
 * not run.
 */
const quotas = () => cloudClient("quotas").quotas;

export async function fetchDesktopRunway(orgId: string): Promise<RunwayListResponse> {
  return runRpc(quotas().runway({ params: { orgId } }));
}

export async function fetchDesktopResourceRunway(
  orgId: string,
  resourceId: string,
): Promise<ResourceRunwayResponse> {
  return runRpc(quotas().resourceRunway({ params: { orgId }, query: { resourceId } }));
}
