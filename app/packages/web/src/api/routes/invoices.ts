import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  managedAccountInputSchema,
  managedInvoiceInputSchema,
  managedInvoiceUpdateSchema,
  managedInvoiceVoidSchema,
} from "@infrawrench/ui/cost/config";
import { MANAGED_INVOICE_STATUSES, type ManagedInvoiceStatus } from "@infrawrench/client-core";
import {
  ManagedAccountError,
  ManagedAccountNameConflictError,
  ManagedAccountScopeConflictError,
  createManagedAccount,
  deleteManagedAccount,
  getManagedAccount,
  listManagedAccounts,
  updateManagedAccount,
} from "@infrawrench/server-core/cost/managed-accounts";
import {
  InvoiceError,
  approveInvoice,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  renderInvoiceCsv,
  sendInvoice,
  updateInvoice,
  voidInvoice,
} from "@infrawrench/server-core/cost/invoices";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Managed accounts and their invoices.
 *
 * ## The permission split, and why it is its own family
 *
 * Reads ride **`invoices:read`**, not `costs:read`. Every other cost surface is
 * the organisation looking at its own spend; this one holds a customer's
 * contact details and the price that customer was quoted, which is commercial
 * information about a third party. A member who can read a cost graph has not
 * thereby been given the customer book.
 *
 * Preparation rides **`invoices:write`** — create a customer, raise a draft,
 * edit a period, delete a draft. All of it revisable, none of it visible
 * outside the organisation.
 *
 * Issuing rides **`invoices:issue`** — approve, send, void. Approval freezes
 * the numbers; sending states that the customer has them; voiding withdraws a
 * document already in their hands. None of the three can be taken back, and the
 * split is what lets an org have a billing clerk prepare a month's invoices
 * while only the finance lead issues them. Collapsing them into one scope would
 * make maker-checker inexpressible, which is the control this domain most
 * obviously needs.
 *
 * Deliberately **not** `org:settings:write`, where billing rules and exchange
 * rates ride. Those are configuration acts that restate the org's own figures.
 * Raising invoices is operational work that recurs every month, and it should
 * not require handing someone SSO, seats and the org's whole money story.
 *
 * Every transition is audit-logged with who did it. An approval nobody can
 * trace back to a person and a date is the failure mode this feature would
 * otherwise introduce — and it is the one an auditor will ask about first.
 *
 * ## What "sent" means here
 *
 * Delivery is out of scope for this pass: nothing in this deployment emails an
 * invoice. `POST /send` records that the document left the building and who let
 * it, and `GET /export` produces the artifact a human attaches to their own
 * mail. That is deliberate — the state transition and its audit trail are the
 * part that has to be right, and a delivery channel can be added later without
 * changing a single stored figure.
 */
const accountsApp = new Hono();
const app = new Hono();

function accountWriteError(c: Context, e: unknown): Response {
  if (e instanceof ManagedAccountNameConflictError) return c.json({ error: e.message }, 409);
  if (e instanceof ManagedAccountScopeConflictError) {
    return c.json({ error: e.message, conflicts: e.conflicts }, 409);
  }
  if (e instanceof ManagedAccountError) return c.json({ error: e.message }, 400);
  throw e;
}

function invoiceError(c: Context, e: unknown): Response {
  if (e instanceof InvoiceError) return c.json({ error: e.message }, e.status);
  throw e;
}

/* ------------------------------------------------------------------ *
 * Managed accounts
 * ------------------------------------------------------------------ */

/** GET /api/org/:orgId/managed-accounts — customers, name-sorted. */
accountsApp.get("/", async (c) => {
  requirePermission(c, "invoices:read");
  return c.json(await listManagedAccounts(c.get("organizationId")));
});

/** GET /api/org/:orgId/managed-accounts/:id — one customer. */
accountsApp.get("/:id", async (c) => {
  requirePermission(c, "invoices:read");
  const account = await getManagedAccount(c.get("organizationId"), c.req.param("id"));
  if (!account) return c.json({ error: "Not found" }, 404);
  return c.json(account);
});

/** POST /api/org/:orgId/managed-accounts — add a customer. */
accountsApp.post("/", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = managedAccountInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid managed account", issues: parsed.error.issues }, 400);
  }

  let account;
  try {
    account = await createManagedAccount(organizationId, parsed.data, session.userId);
  } catch (e) {
    return accountWriteError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "managed_account.create",
    entityType: "managed_account",
    entityId: account.id,
    metadata: {
      name: account.name,
      billingCurrency: account.billingCurrency,
      costCentreIds: account.costCentreIds,
      accountIds: account.accountIds,
    },
  });
  return c.json(account);
});

/**
 * PUT /api/org/:orgId/managed-accounts/:id — full replace.
 *
 * Editing the scope changes what future drafts are drawn over and nothing else:
 * every approved invoice holds its own copy of the scope, so moving a cost
 * centre between customers cannot re-bill a period already invoiced.
 */
accountsApp.put("/:id", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = managedAccountInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid managed account", issues: parsed.error.issues }, 400);
  }

  let account;
  try {
    account = await updateManagedAccount(organizationId, c.req.param("id"), parsed.data);
  } catch (e) {
    return accountWriteError(c, e);
  }
  if (!account) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "managed_account.update",
    entityType: "managed_account",
    entityId: account.id,
    metadata: {
      name: account.name,
      billingCurrency: account.billingCurrency,
      costCentreIds: account.costCentreIds,
      accountIds: account.accountIds,
    },
  });
  return c.json(account);
});

/**
 * DELETE /api/org/:orgId/managed-accounts/:id — retire a customer.
 *
 * Soft: an issued invoice names its customer, and an invoice whose customer
 * stopped resolving is exactly the unreconcilable document this feature exists
 * to prevent. Draft invoices go with it — a draft was never issued.
 */
accountsApp.delete("/:id", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const deleted = await deleteManagedAccount(organizationId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "managed_account.delete",
    entityType: "managed_account",
    entityId: id,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Invoices
 * ------------------------------------------------------------------ */

const listQuerySchema = z.object({
  managedAccountId: z.string().min(1).optional(),
  status: z.enum(MANAGED_INVOICE_STATUSES).optional(),
});

/**
 * GET /api/org/:orgId/invoices — summaries, newest period first.
 *
 * Summaries, not full invoices: a draft's figures are recomputed on read, and
 * recomputing every draft would make opening the list one ClickHouse scan per
 * draft. A draft's `totals` is therefore null here — null, not zero, because
 * zero is a lie the reader cannot detect.
 */
app.get("/", async (c) => {
  requirePermission(c, "invoices:read");
  const parsed = listQuerySchema.safeParse({
    managedAccountId: c.req.query("managedAccountId"),
    status: c.req.query("status"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid filter", issues: parsed.error.issues }, 400);
  }
  return c.json(
    await listInvoices(c.get("organizationId"), {
      managedAccountId: parsed.data.managedAccountId,
      status: parsed.data.status as ManagedInvoiceStatus | undefined,
    }),
  );
});

/**
 * GET /api/org/:orgId/invoices/:id — one invoice, with its lines.
 *
 * A **draft recomputes** from live spend on every read; `live: true` says so.
 * An approved, sent or void invoice returns the figures written at approval and
 * does not touch cost data at all.
 */
app.get("/:id", async (c) => {
  requirePermission(c, "invoices:read");
  let invoice;
  try {
    invoice = await getInvoice(c.get("organizationId"), c.req.param("id"));
  } catch (e) {
    return invoiceError(c, e);
  }
  if (!invoice) return c.json({ error: "Not found" }, 404);
  return c.json(invoice);
});

/**
 * GET /api/org/:orgId/invoices/:id/export — the invoice as CSV.
 *
 * The derivation, not a rendered document: what was collected, what the rules
 * added, the rate and the day it was read, and the final figure. It is the
 * numbers that have to survive being argued with.
 */
app.get("/:id/export", async (c) => {
  requirePermission(c, "invoices:read");
  let invoice;
  try {
    invoice = await getInvoice(c.get("organizationId"), c.req.param("id"));
  } catch (e) {
    return invoiceError(c, e);
  }
  if (!invoice) return c.json({ error: "Not found" }, 404);

  const filename = `${invoice.number ?? `draft-${invoice.id.slice(0, 8)}`}.csv`;
  return new Response(renderInvoiceCsv(invoice), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

/** POST /api/org/:orgId/invoices — raise a draft. Always a draft. */
app.post("/", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = managedInvoiceInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid invoice", issues: parsed.error.issues }, 400);
  }

  let invoice;
  try {
    invoice = await createInvoice(organizationId, parsed.data, session.userId);
  } catch (e) {
    return invoiceError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "invoice.create",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: {
      managedAccountId: invoice.managedAccountId,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      supersedesInvoiceId: invoice.supersedesInvoiceId,
    },
  });
  return c.json(invoice);
});

/** PUT /api/org/:orgId/invoices/:id — edit a draft's period or notes. */
app.put("/:id", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = managedInvoiceUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid invoice", issues: parsed.error.issues }, 400);
  }

  let invoice;
  try {
    invoice = await updateInvoice(organizationId, c.req.param("id"), parsed.data);
  } catch (e) {
    return invoiceError(c, e);
  }
  if (!invoice) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "invoice.update",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: { periodFrom: invoice.periodFrom, periodTo: invoice.periodTo },
  });
  return c.json(invoice);
});

/**
 * DELETE /api/org/:orgId/invoices/:id — delete a draft.
 *
 * Only a draft. An issued invoice is voided, never deleted, and the service
 * refuses it independently of this route.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  let deleted;
  try {
    deleted = await deleteInvoice(organizationId, id);
  } catch (e) {
    return invoiceError(c, e);
  }
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "invoice.delete",
    entityType: "invoice",
    entityId: id,
  });
  return c.json({ ok: true });
});

/**
 * POST /api/org/:orgId/invoices/:id/approve — the freeze.
 *
 * A distinct act from generation, on a distinct permission, with its own audit
 * entry. After this the figures are stored bytes: no restatement of spend, no
 * exchange-rate change, no rule edit and no rename can alter what this document
 * says.
 */
app.post("/:id/approve", async (c) => {
  requirePermission(c, "invoices:issue");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  let invoice;
  try {
    invoice = await approveInvoice(organizationId, c.req.param("id"), session.userId);
  } catch (e) {
    return invoiceError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "invoice.approve",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: {
      number: invoice.number,
      managedAccountName: invoice.managedAccountName,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      currency: invoice.currency,
      // The frozen figure, in the audit entry itself: "who approved what" is
      // not answerable later if the answer requires re-opening the invoice.
      billed: invoice.totals.billed,
      rateDate: invoice.derivation.rateDate,
    },
  });
  return c.json(invoice);
});

/** POST /api/org/:orgId/invoices/:id/send — record that the customer has it. */
app.post("/:id/send", async (c) => {
  requirePermission(c, "invoices:issue");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  let invoice;
  try {
    invoice = await sendInvoice(organizationId, c.req.param("id"), session.userId);
  } catch (e) {
    return invoiceError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "invoice.send",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: { number: invoice.number, managedAccountName: invoice.managedAccountName },
  });
  return c.json(invoice);
});

/**
 * POST /api/org/:orgId/invoices/:id/void — withdraw an issued invoice.
 *
 * The original keeps every figure it was sent with. With `supersede`, the
 * corrective draft is raised in the same call and linked both ways, because a
 * correction left half-made by a failed second request is the state nobody
 * notices until the customer asks.
 */
app.post("/:id/void", async (c) => {
  requirePermission(c, "invoices:issue");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = managedInvoiceVoidSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid void request", issues: parsed.error.issues }, 400);
  }

  let result;
  try {
    result = await voidInvoice(
      organizationId,
      c.req.param("id"),
      session.userId,
      parsed.data.reason,
      parsed.data.supersede,
    );
  } catch (e) {
    return invoiceError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "invoice.void",
    entityType: "invoice",
    entityId: result.invoice.id,
    metadata: {
      number: result.invoice.number,
      reason: parsed.data.reason,
      supersededByInvoiceId: result.replacement?.id ?? null,
    },
  });
  if (result.replacement) {
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "invoice.create",
      entityType: "invoice",
      entityId: result.replacement.id,
      metadata: {
        managedAccountId: result.replacement.managedAccountId,
        periodFrom: result.replacement.periodFrom,
        periodTo: result.replacement.periodTo,
        supersedesInvoiceId: result.invoice.id,
      },
    });
  }
  return c.json(result);
});

export { accountsApp as managedAccountRoutes, app as invoiceRoutes };
