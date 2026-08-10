import type {
  CostCentre,
  ManagedAccount,
  ManagedAccountInput,
  ManagedInvoice,
  ManagedInvoiceInput,
  ManagedInvoiceSummary,
  ManagedInvoiceUpdate,
} from "@infrawrench/client-core";

/** One cloud account, as the scope picker needs it. */
export interface InvoiceScopeAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/**
 * Host-injected data access for the invoice components — the same rule the cost
 * and cost-report clients follow: web wraps `apiFetch`, desktop wraps its
 * cloud-api helpers, and nothing in here imports a platform primitive.
 *
 * The optional halves map onto the three permissions the server enforces, so a
 * host builds exactly the client the caller's grants justify and the panel
 * renders what is actually possible rather than buttons that 403 on click:
 *
 * - the required methods are `invoices:read`;
 * - `createManagedAccount` … `deleteInvoice` are `invoices:write`;
 * - `approveInvoice`, `sendInvoice`, `voidInvoice` are `invoices:issue`.
 *
 * That last split is the point of the family: a billing clerk gets a client
 * with the write half and no issue half, and the panel shows Approve greyed
 * with the reason rather than pretending they can freeze a customer's numbers.
 */
export interface InvoicesClient {
  listManagedAccounts(): Promise<ManagedAccount[]>;
  listInvoices(): Promise<ManagedInvoiceSummary[]>;
  getInvoice(invoiceId: string): Promise<ManagedInvoice>;
  /** Cost centres, for the scope picker — never a free-text id field. */
  listCostCentres(): Promise<CostCentre[]>;
  /** Cloud accounts, for the scope picker. */
  listAccounts(): Promise<InvoiceScopeAccount[]>;
  /** The download URL for an invoice's CSV, or undefined when unsupported. */
  invoiceExportUrl?(invoiceId: string): string;

  createManagedAccount?(input: ManagedAccountInput): Promise<ManagedAccount>;
  updateManagedAccount?(id: string, input: ManagedAccountInput): Promise<ManagedAccount>;
  deleteManagedAccount?(id: string): Promise<void>;
  createInvoice?(input: ManagedInvoiceInput): Promise<ManagedInvoice>;
  updateInvoice?(invoiceId: string, input: ManagedInvoiceUpdate): Promise<ManagedInvoice>;
  deleteInvoice?(invoiceId: string): Promise<void>;

  approveInvoice?(invoiceId: string): Promise<ManagedInvoice>;
  sendInvoice?(invoiceId: string): Promise<ManagedInvoice>;
  voidInvoice?(
    invoiceId: string,
    reason: string,
    supersede: boolean,
  ): Promise<{ invoice: ManagedInvoice; replacement: ManagedInvoice | null }>;
}
