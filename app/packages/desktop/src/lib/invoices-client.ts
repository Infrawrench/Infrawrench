import { downloadBlob, useUIStore } from "@infrawrench/ui";
import type { InvoiceScopeAccount, InvoicesClient } from "@infrawrench/ui/invoices";
import type {
  BillingProfile,
  BillingProfileInput,
  ManagedAccountAssignmentInput,
  ManagedAccountAssignmentPreview,
  UnassignedSpendReport,
  CostCentre,
  ManagedAccount,
  ManagedAccountInput,
  ManagedInvoice,
  ManagedInvoiceInput,
  ManagedInvoiceSummary,
  ManagedInvoiceUpdate,
  PricingPreviewRequest,
  PricingPreviewResult,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";
import { listCloudAccounts } from "./cloud-accounts";
import { loadCloudCostDimensionValues } from "./cloud-costs";

/**
 * Invoices are cloud-only for the same reason cost reports are: the spend they
 * bill for is collected server-side, so a desktop app in local mode has nothing
 * to invoice. Every call resolves the active org at call time rather than
 * closing over it: the org can change under a mounted panel.
 *
 * `invoiceExportUrl` and `invoicePdfUrl` are deliberately **not** implemented
 * here: the cloud endpoints need a Bearer header, which an `<a download>`
 * cannot carry. `downloadInvoiceFile` fetches the bytes over IPC instead and
 * saves them through the same Blob download every other desktop export uses.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Invoices require cloud mode: sign in to sync.");
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
    listCostDimension: (dimension: "provider" | "service") =>
      loadCloudCostDimensionValues(requireOrgId(), dimension),
    previewPricing: (request: PricingPreviewRequest) =>
      invoke<PricingPreviewResult>("cloud_preview_pricing", { orgId: requireOrgId(), request }),

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

    downloadInvoiceFile: async (invoice: ManagedInvoice, format: "csv" | "pdf") => {
      const bytes = await invoke<Uint8Array>("cloud_invoice_file", {
        orgId: requireOrgId(),
        invoiceId: invoice.id,
        format,
      });
      const name = invoice.number ?? `draft-${invoice.id.slice(0, 8)}`;
      downloadBlob(
        new Blob([new Uint8Array(bytes)], {
          type: format === "pdf" ? "application/pdf" : "text/csv;charset=utf-8",
        }),
        `${name}.${format}`,
      );
    },

    listBillingProfiles: async () =>
      (await invoke<BillingProfile[]>("cloud_list_billing_profiles", { orgId: requireOrgId() })) ??
      [],
    createBillingProfile: (input: BillingProfileInput) =>
      invoke<BillingProfile>("cloud_create_billing_profile", { orgId: requireOrgId(), input }),
    updateBillingProfile: (id: string, input: BillingProfileInput) =>
      invoke<BillingProfile>("cloud_update_billing_profile", { orgId: requireOrgId(), id, input }),
    deleteBillingProfile: async (id: string) => {
      await invoke("cloud_delete_billing_profile", { orgId: requireOrgId(), id });
    },

    findUnassignedSpend: (period?: { from: string; to: string }) =>
      invoke<UnassignedSpendReport>("cloud_unassigned_spend", { orgId: requireOrgId(), period }),
    previewAssignment: (
      input: ManagedAccountAssignmentInput & { periodFrom?: string; periodTo?: string },
    ) =>
      invoke<ManagedAccountAssignmentPreview>("cloud_preview_managed_account_assignment", {
        orgId: requireOrgId(),
        input,
      }),
    assignScope: (input: ManagedAccountAssignmentInput) =>
      invoke<{ accounts: ManagedAccount[] }>("cloud_assign_managed_account_scope", {
        orgId: requireOrgId(),
        input,
      }),
  };
}
