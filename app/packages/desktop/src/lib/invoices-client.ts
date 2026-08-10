import { useUIStore } from "@infrawrench/ui";
import type { InvoiceScopeAccount, InvoicesClient } from "@infrawrench/ui/invoices";
import type {
  CostCentre,
  ManagedAccount,
  ManagedAccountInput,
  ManagedInvoice,
  ManagedInvoiceInput,
  ManagedInvoiceSummary,
  ManagedInvoiceUpdate,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";
import { listCloudAccounts } from "./cloud-accounts";

/**
 * Invoices are cloud-only for the same reason cost reports are: the spend they
 * bill for is collected server-side, so a desktop app in local mode has nothing
 * to invoice. Every call resolves the active org at call time rather than
 * closing over it — the org can change under a mounted panel.
 *
 * `invoiceExportUrl` is deliberately **not** implemented here, so the Download
 * CSV button does not render on desktop. The cloud endpoint needs a Bearer
 * header, which an `<a download>` cannot carry, and the honest options were a
 * button that 401s or a save-dialog flow that belongs in a change of its own.
 * The web app has the download; see the docs.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Invoices require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopInvoicesClient(): InvoicesClient {
  return {
    listManagedAccounts: async () =>
      (await invoke<ManagedAccount[]>("cloud_list_managed_accounts", {
        orgId: requireOrgId(),
      })) ?? [],
    listInvoices: async () =>
      (await invoke<ManagedInvoiceSummary[]>("cloud_list_invoices", { orgId: requireOrgId() })) ??
      [],
    getInvoice: (invoiceId: string) =>
      invoke<ManagedInvoice>("cloud_get_invoice", { orgId: requireOrgId(), invoiceId }),
    listCostCentres: async () =>
      (await invoke<CostCentre[]>("cloud_list_cost_centres", { orgId: requireOrgId() })) ?? [],
    listAccounts: async () => {
      const rows = await listCloudAccounts(requireOrgId());
      return (rows ?? []).map((a): InvoiceScopeAccount => ({
        id: a.id,
        displayName: a.displayName,
        pluginId: a.pluginId,
      }));
    },

    createManagedAccount: (input: ManagedAccountInput) =>
      invoke<ManagedAccount>("cloud_create_managed_account", { orgId: requireOrgId(), input }),
    updateManagedAccount: (id: string, input: ManagedAccountInput) =>
      invoke<ManagedAccount>("cloud_update_managed_account", { orgId: requireOrgId(), id, input }),
    deleteManagedAccount: async (id: string) => {
      await invoke("cloud_delete_managed_account", { orgId: requireOrgId(), id });
    },
    createInvoice: (input: ManagedInvoiceInput) =>
      invoke<ManagedInvoice>("cloud_create_invoice", { orgId: requireOrgId(), input }),
    updateInvoice: (invoiceId: string, input: ManagedInvoiceUpdate) =>
      invoke<ManagedInvoice>("cloud_update_invoice", { orgId: requireOrgId(), invoiceId, input }),
    deleteInvoice: async (invoiceId: string) => {
      await invoke("cloud_delete_invoice", { orgId: requireOrgId(), invoiceId });
    },

    approveInvoice: (invoiceId: string) =>
      invoke<ManagedInvoice>("cloud_approve_invoice", { orgId: requireOrgId(), invoiceId }),
    sendInvoice: (invoiceId: string, resend = false) =>
      invoke<ManagedInvoice>("cloud_send_invoice", { orgId: requireOrgId(), invoiceId, resend }),
    voidInvoice: (invoiceId: string, reason: string, supersede: boolean) =>
      invoke<{ invoice: ManagedInvoice; replacement: ManagedInvoice | null }>(
        "cloud_void_invoice",
        { orgId: requireOrgId(), invoiceId, reason, supersede },
      ),
  };
}
