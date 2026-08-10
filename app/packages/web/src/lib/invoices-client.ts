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
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * Web host for the invoices panel.
 *
 * The mutating and issuing halves are included **unconditionally** rather than
 * gated on the caller's permissions, the same stance the cost-reports client
 * takes on delivery schedules: a 403 surfaces as the action's own error, which
 * is a message the user can act on, where a silently missing Approve button is
 * a bug report. Panel-level affordances still come from the presence of the
 * methods, so a host that genuinely cannot issue (a future read-only embed) can
 * still omit them.
 */
export function createWebInvoicesClient(orgId: string): InvoicesClient {
  const base = `/api/org/${orgId}`;
  return {
    listManagedAccounts: () => apiGet<ManagedAccount[]>(`${base}/managed-accounts`),
    listInvoices: () => apiGet<ManagedInvoiceSummary[]>(`${base}/invoices`),
    getInvoice: (invoiceId: string) => apiGet<ManagedInvoice>(`${base}/invoices/${invoiceId}`),
    listCostCentres: () => apiGet<CostCentre[]>(`${base}/cost-centres`),
    listAccounts: () => apiGet<InvoiceScopeAccount[]>(`${base}/accounts`),
    // A plain link, not a fetch: the browser's own download handling gets the
    // Content-Disposition filename right and streams without buffering the CSV
    // into memory first. Session auth rides the cookie.
    invoiceExportUrl: (invoiceId: string) => `${base}/invoices/${invoiceId}/export`,

    createManagedAccount: (input: ManagedAccountInput) =>
      apiPost<ManagedAccount>(`${base}/managed-accounts`, input),
    updateManagedAccount: (id: string, input: ManagedAccountInput) =>
      apiPut<ManagedAccount>(`${base}/managed-accounts/${id}`, input),
    deleteManagedAccount: async (id: string) => {
      await apiDelete(`${base}/managed-accounts/${id}`);
    },
    createInvoice: (input: ManagedInvoiceInput) =>
      apiPost<ManagedInvoice>(`${base}/invoices`, input),
    updateInvoice: (invoiceId: string, input: ManagedInvoiceUpdate) =>
      apiPut<ManagedInvoice>(`${base}/invoices/${invoiceId}`, input),
    deleteInvoice: async (invoiceId: string) => {
      await apiDelete(`${base}/invoices/${invoiceId}`);
    },

    approveInvoice: (invoiceId: string) =>
      apiPost<ManagedInvoice>(`${base}/invoices/${invoiceId}/approve`, {}),
    sendInvoice: (invoiceId: string, resend = false) =>
      apiPost<ManagedInvoice>(`${base}/invoices/${invoiceId}/send`, { resend }),
    voidInvoice: (invoiceId: string, reason: string, supersede: boolean) =>
      apiPost<{ invoice: ManagedInvoice; replacement: ManagedInvoice | null }>(
        `${base}/invoices/${invoiceId}/void`,
        { reason, supersede },
      ),
  };
}
