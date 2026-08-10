/**
 * Managed-account and invoice tools.
 *
 * **Read-only, deliberately.** Approving an invoice freezes the figures a
 * customer will be sent, and sending one states that they have it; neither is
 * an act a model should be able to take because it inferred from a conversation
 * that it was time. The write path is the HTTP API and the UI, where a person
 * clicks a button and an audit entry names them.
 *
 * What the model gets instead is the whole derivation: what was collected, what
 * the org's billing rules added, the rate that converted it and the day that
 * rate was read. That is exactly what "why is this customer being billed this"
 * needs, and it is the question worth answering here.
 */
import { z } from "zod";
import { MANAGED_INVOICE_STATUSES, type ManagedInvoiceStatus } from "@infrawrench/client-core";
import {
  getManagedAccount,
  listManagedAccounts,
} from "@infrawrench/server-core/cost/managed-accounts";
import { getInvoice, listInvoices } from "@infrawrench/server-core/cost/invoices";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

export function invoiceTools(): ToolDefinition[] {
  return [
    {
      name: "list_managed_accounts",
      title: "List managed accounts",
      description:
        "The customers this organization bills for infrastructure it runs on their behalf. Each " +
        "one names a billing currency and the cost centres (and cloud accounts) whose spend " +
        "belongs to them.\n\n" +
        "A managed account does **not** define its own matching rules — it references cost " +
        "centres, and the organization's allocation rules decide what lands in those. So the " +
        "spend on a customer's invoice is the same spend `query_showback` attributes to those " +
        "centres for the same period. A cost centre or account belongs to at most one customer.\n\n" +
        "`costCentreIds` includes whole subtrees: naming a parent bills every descendant. " +
        "`accountIds` claims an account's spend only where no cost centre already claimed it.",
      inputSchema: {},
      risk: "read",
      permission: "invoices:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "invoices:read");
        if (denied) return denied;
        return ok(await listManagedAccounts(auth.organizationId));
      },
    },
    {
      name: "get_managed_account",
      title: "Get a managed account",
      description:
        "One customer in full, including contact details, billing currency, cost basis, whether " +
        "the organization's billing rules apply to their invoices, and the exact scope their " +
        "invoices are drawn over.",
      inputSchema: { managedAccountId: z.string().min(1) },
      risk: "read",
      permission: "invoices:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "invoices:read");
        if (denied) return denied;
        const id = input["managedAccountId"] as string;
        const account = await getManagedAccount(auth.organizationId, id);
        if (!account) return err(`Managed account not found: ${id}`);
        return ok(account);
      },
    },
    {
      name: "list_invoices",
      title: "List invoices",
      description:
        "Invoices raised against managed accounts, newest period first. Optionally filtered to " +
        "one customer or one status.\n\n" +
        "Statuses are `draft` → `approved` → `sent`, plus `void`. **A draft's `totals` is null " +
        "here, not zero**: a draft's figures are recomputed from live spend on every read and " +
        "this list does not recompute. Call `get_invoice` for a draft's current numbers, and do " +
        "not report a draft as being worth nothing.\n\n" +
        "An issued invoice is never edited and never deleted — a wrong one is voided and " +
        "superseded by a corrective invoice, which is why you may see two invoices for one " +
        "period with `supersedesInvoiceId` linking them.",
      inputSchema: {
        managedAccountId: z.string().min(1).optional(),
        status: z.enum(MANAGED_INVOICE_STATUSES).optional(),
      },
      risk: "read",
      permission: "invoices:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "invoices:read");
        if (denied) return denied;
        return ok(
          await listInvoices(auth.organizationId, {
            managedAccountId: input["managedAccountId"] as string | undefined,
            status: input["status"] as ManagedInvoiceStatus | undefined,
          }),
        );
      },
    },
    {
      name: "get_invoice",
      title: "Get an invoice",
      description:
        "One invoice with its line items and the full derivation behind every figure.\n\n" +
        "Each line carries `collected` (what the providers charged), `adjustment` (what the " +
        "organization's billing rules added or removed), `adjusted` (their sum), the exchange " +
        "`rate` and the `billed` amount in the customer's currency. " +
        "`collected + adjustment === adjusted` holds for every currency — that identity is what " +
        "makes an invoice reconcilable, and it is the arithmetic to quote when asked why a " +
        "customer is being charged what they are.\n\n" +
        "`live` distinguishes the two kinds of answer. `live: true` means this is a **draft** " +
        "and the figures were recomputed for this call: they will move as cost data restates. " +
        "`live: false` means the invoice was approved and its figures are frozen — the rates in " +
        "`derivation.rates`, the rules in `derivation.rules` and the names in `derivation.scope` " +
        "are the ones that applied at issue time, not the ones that apply now. Never describe a " +
        "frozen invoice as out of date; it is a document, not a query.",
      inputSchema: { invoiceId: z.string().min(1) },
      risk: "read",
      permission: "invoices:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "invoices:read");
        if (denied) return denied;
        const id = input["invoiceId"] as string;
        const invoice = await getInvoice(auth.organizationId, id);
        if (!invoice) return err(`Invoice not found: ${id}`);
        return ok(invoice);
      },
    },
  ];
}
