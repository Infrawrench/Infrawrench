import type {
  SavingsFindingStatusResult,
  SavingsFindingsResponse,
  SavingsView,
} from "@infrawrench/client-core";
import { useUIStore, type SavingsFindingsClient } from "@infrawrench/ui";
import { createDesktopSharingClient } from "./cost-reports-client";
import { invoke } from "./invoke";

/**
 * The savings findings workflow's data access; cloud-mode only (the caller
 * leaves the section off without an active cloud org). The org is resolved at
 * call time, the seats-client convention, so switching org under a mounted
 * Costs tab reaches the right data.
 */
export function createDesktopSavingsFindingsClient(): SavingsFindingsClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sign in to Infrawrench Cloud to see savings findings");
    return orgId;
  };
  return {
    listFindings: (opts) =>
      invoke<SavingsFindingsResponse>("cloud_savings_findings_list", {
        orgId: requireOrg(),
        refresh: opts?.refresh === true,
      }),
    setStatus: (input) =>
      invoke<SavingsFindingStatusResult>("cloud_savings_findings_status", {
        orgId: requireOrg(),
        input,
      }),
    listViews: () => invoke<SavingsView[]>("cloud_savings_views_list", { orgId: requireOrg() }),
    createView: (input) =>
      invoke<SavingsView>("cloud_savings_view_create", { orgId: requireOrg(), input }),
    updateView: (id, input) =>
      invoke<SavingsView>("cloud_savings_view_update", { orgId: requireOrg(), id, input }),
    deleteView: (id) => invoke<void>("cloud_savings_view_delete", { orgId: requireOrg(), id }),
    sharing: createDesktopSharingClient(),
  };
}
