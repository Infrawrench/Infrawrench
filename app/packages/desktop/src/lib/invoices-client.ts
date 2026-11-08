import { downloadBlob, useUIStore } from "@infrawrench/ui";
import type { InvoiceScopeAccount, InvoicesClient } from "@infrawrench/ui/invoices";
import type {
  BillingProfile,
  BillingRuleInput,
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
import { cloudClient } from "./cloud-client";
import { definedFields } from "./cloud-payload";
import { runRpc } from "./rpc/client";
import { listCloudAccounts } from "./cloud-accounts";
import { listCloudCostCentresForCosts, loadCloudCostDimensionValues } from "./cloud-costs";

/**
 * Invoices are cloud-only for the same reason cost reports are: the spend they
 * bill for is collected server-side, so a desktop app in local mode has nothing
 * to invoice. Every call resolves the active org at call time rather than
 * closing over it: the org can change under a mounted panel.
 *
 * Typed calls to the contract's `invoices`, `billingProfiles` and
 * `billingRules` domains over the cloud transport (`./cloud-client.ts`).
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

const managedAccounts = () => cloudClient("invoices").managedAccounts;
const invoices = () => cloudClient("invoices").invoices;
const billingProfiles = () => cloudClient("billingProfiles").billingProfiles;

/**
 * A candidate rule as the preview endpoint takes it. client-core's
 * `BillingRuleInput` leaves `description` and every adjustment field but
 * `kind` optional; the contract's decoded type (what a request is written
 * in) requires them, because the server fills an absent one with null. The
 * same nulls are filled here.
 */
function ruleInput(rule: BillingRuleInput) {
  const { adjustment, managedAccountIds } = rule;
  return {
    name: rule.name,
    description: rule.description ?? null,
    enabled: rule.enabled,
    priority: rule.priority,
    match: definedFields(rule.match),
    adjustment: {
      kind: adjustment.kind,
      percent: adjustment.percent ?? null,
      amount: adjustment.amount ?? null,
      currency: adjustment.currency ?? null,
      period: adjustment.period ?? null,
      targetKind: adjustment.targetKind ?? null,
      targetId: adjustment.targetId ?? null,
      tiers: adjustment.tiers ? definedFields(adjustment.tiers) : null,
      tierMode: adjustment.tierMode ?? null,
      tierScope: adjustment.tierScope ?? null,
      expression: adjustment.expression ?? null,
    },
    ...(managedAccountIds !== undefined ? { managedAccountIds } : {}),
  };
}

function previewPayload(request: PricingPreviewRequest) {
  const { rule, ...rest } = request;
  return {
    ...definedFields(rest),
    ...(rule !== undefined ? { rule: rule === null ? null : ruleInput(rule) } : {}),
  };
}

export function createDesktopInvoicesClient(): InvoicesClient {
  // Every method is async so a missing org rejects rather than throwing
  // synchronously: a caller chaining `.catch()` off one would miss a throw.
  return {
    listManagedAccounts: async (): Promise<ManagedAccount[]> =>
      runRpc(managedAccounts().list({ params: { orgId: requireOrgId() } })),
    listInvoices: async (): Promise<ManagedInvoiceSummary[]> =>
      runRpc(invoices().list({ params: { orgId: requireOrgId() }, query: {} })),
    getInvoice: async (invoiceId: string): Promise<ManagedInvoice> =>
      runRpc(invoices().get({ params: { orgId: requireOrgId(), id: invoiceId } })),
    listCostCentres: async (): Promise<CostCentre[]> =>
      listCloudCostCentresForCosts(requireOrgId()),
    listAccounts: async () => {
      const rows = await listCloudAccounts(requireOrgId());
      return (rows ?? []).map((a): InvoiceScopeAccount => ({
        id: a.id,
        displayName: a.displayName,
        pluginId: a.pluginId,
      }));
    },
    listCostDimension: async (dimension: "provider" | "service") =>
      loadCloudCostDimensionValues(requireOrgId(), dimension),
    previewPricing: async (request: PricingPreviewRequest): Promise<PricingPreviewResult> =>
      runRpc(
        cloudClient("billingRules").billingRules.preview({
          params: { orgId: requireOrgId() },
          payload: previewPayload(request),
        }),
      ),

    createManagedAccount: async (input: ManagedAccountInput): Promise<ManagedAccount> =>
      runRpc(
        managedAccounts().create({
          params: { orgId: requireOrgId() },
          payload: definedFields(input),
        }),
      ),
    updateManagedAccount: async (id: string, input: ManagedAccountInput): Promise<ManagedAccount> =>
      runRpc(
        managedAccounts().update({
          params: { orgId: requireOrgId(), id },
          payload: definedFields(input),
        }),
      ),
    deleteManagedAccount: async (id: string) => {
      await runRpc(managedAccounts().delete({ params: { orgId: requireOrgId(), id } }));
    },
    createInvoice: async (input: ManagedInvoiceInput): Promise<ManagedInvoice> =>
      runRpc(
        invoices().create({ params: { orgId: requireOrgId() }, payload: definedFields(input) }),
      ),
    updateInvoice: async (
      invoiceId: string,
      input: ManagedInvoiceUpdate,
    ): Promise<ManagedInvoice> =>
      runRpc(
        invoices().update({
          params: { orgId: requireOrgId(), id: invoiceId },
          payload: definedFields(input),
        }),
      ),
    deleteInvoice: async (invoiceId: string) => {
      await runRpc(invoices().delete({ params: { orgId: requireOrgId(), id: invoiceId } }));
    },

    approveInvoice: async (invoiceId: string): Promise<ManagedInvoice> =>
      runRpc(invoices().approve({ params: { orgId: requireOrgId(), id: invoiceId } })),
    sendInvoice: async (invoiceId: string, resend = false): Promise<ManagedInvoice> =>
      runRpc(
        invoices().send({
          params: { orgId: requireOrgId(), id: invoiceId },
          // `resend` is the deliberate second copy; the server refuses one
          // without it once a delivery has landed.
          payload: { resend },
        }),
      ),
    voidInvoice: async (
      invoiceId: string,
      reason: string,
      supersede: boolean,
    ): Promise<{ invoice: ManagedInvoice; replacement: ManagedInvoice | null }> =>
      runRpc(
        invoices().void({
          params: { orgId: requireOrgId(), id: invoiceId },
          payload: { reason, supersede },
        }),
      ),

    downloadInvoiceFile: async (invoice: ManagedInvoice, format: "csv" | "pdf") => {
      const params = { orgId: requireOrgId(), id: invoice.id };
      // The PDF answers bytes; the CSV answers text, saved as its UTF-8 bytes.
      const bytes =
        format === "pdf"
          ? await runRpc(invoices().pdf({ params }))
          : new TextEncoder().encode(await runRpc(invoices().export({ params })));
      const name = invoice.number ?? `draft-${invoice.id.slice(0, 8)}`;
      downloadBlob(
        new Blob([new Uint8Array(bytes)], {
          type: format === "pdf" ? "application/pdf" : "text/csv;charset=utf-8",
        }),
        `${name}.${format}`,
      );
    },

    listBillingProfiles: async (): Promise<BillingProfile[]> =>
      runRpc(billingProfiles().list({ params: { orgId: requireOrgId() } })),
    createBillingProfile: async (input: BillingProfileInput): Promise<BillingProfile> =>
      runRpc(
        billingProfiles().create({
          params: { orgId: requireOrgId() },
          payload: definedFields(input),
        }),
      ),
    updateBillingProfile: async (id: string, input: BillingProfileInput): Promise<BillingProfile> =>
      runRpc(
        billingProfiles().update({
          params: { orgId: requireOrgId(), id },
          payload: definedFields(input),
        }),
      ),
    deleteBillingProfile: async (id: string) => {
      await runRpc(billingProfiles().delete({ params: { orgId: requireOrgId(), id } }));
    },

    findUnassignedSpend: async (period?: {
      from: string;
      to: string;
    }): Promise<UnassignedSpendReport> =>
      runRpc(
        managedAccounts().unassigned({
          params: { orgId: requireOrgId() },
          query: period ? { from: period.from, to: period.to } : {},
        }),
      ),
    previewAssignment: async (
      input: ManagedAccountAssignmentInput & { periodFrom?: string; periodTo?: string },
    ): Promise<ManagedAccountAssignmentPreview> =>
      runRpc(
        managedAccounts().previewAssignment({
          params: { orgId: requireOrgId() },
          payload: input,
        }),
      ),
    assignScope: async (
      input: ManagedAccountAssignmentInput,
    ): Promise<{ accounts: ManagedAccount[] }> =>
      runRpc(
        managedAccounts().assign({
          params: { orgId: requireOrgId() },
          payload: definedFields(input),
        }),
      ),
  };
}
