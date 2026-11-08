/**
 * Managed accounts and their invoices: `/api/org/:orgId/managed-accounts`
 * and `/api/org/:orgId/invoices`, the handlers. The services are promise code
 * and run through `legacy`, inside the request's scopes.
 *
 * Every transition is audit-logged with who did it. An approval nobody can
 * trace back to a person and a date is the failure mode this feature would
 * otherwise introduce, and it is the one an auditor will ask about first.
 *
 * ## What "sent" means here
 *
 * Two facts, recorded separately and never conflated. `POST /send` records the
 * **release**: the document may go to the customer, and this person said so,
 * and then emails it to the recipients frozen at approval (the customer's
 * contact plus its billing profile's To and Cc) with the PDF and the CSV
 * attached. The release is written once; the delivery outcome is written per
 * attempt, and neither can touch a figure frozen at approval.
 *
 * The response is a 200 with the outcome in `delivery`, including when the
 * mail failed. A 500 would tell the caller nothing about whether the release
 * stuck, and the release did stick: it is the transport that failed, the
 * invoice is visibly "sent, delivery failed", and sending again retries it.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import {
  ManagedAccountAssignment,
  ManagedAccountAssignmentPreview,
  ManagedInvoiceSend,
  ManagedInvoiceVoid,
} from "@infrawrench/ui/schemas";
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
  renderInvoicePdfFor,
  sendInvoice,
  updateInvoice,
  voidInvoice,
} from "@infrawrench/server-core/cost/invoices";
import {
  assignManagedAccountScope,
  findUnassignedSpend,
  previewManagedAccountAssignment,
} from "@infrawrench/server-core/cost/managed-account-scope";
import { invoicePdfFilename } from "@infrawrench/server-core/cost/invoice-pdf";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, Conflict, HttpFailure, notFound } from "../../errors";
import { decodeAsPayload, readJson, readJsonOr } from "../../json-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal } from "../../object-body";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  Invoice,
  InvoicesApi,
  InvoiceSummary,
  InvoiceVoidResponse,
  ManagedAccount,
  ManagedAccountAssignmentPreviewResult,
  ManagedAccountAssignmentResult,
  UnassignedPeriodQuery,
  UnassignedSpendReport,
} from "./api";

/**
 * A managed-account write's refusals: a taken name or a scope already billed
 * to another customer is a 409 (the latter naming who, in an already-shaped
 * body), anything else the service refused a 400.
 */
const accountCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(
    async () => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof ManagedAccountScopeConflictError) {
          throw new HttpFailure(409, { error: error.message, conflicts: error.conflicts });
        }
        throw error;
      }
    },
    (error) => {
      if (error instanceof ManagedAccountNameConflictError) {
        return new Conflict({ error: error.message });
      }
      if (error instanceof ManagedAccountError) return new BadRequest({ error: error.message });
      return undefined;
    },
  );

/** An invoice call: the service's refusal, verbatim, with the status it carries. */
const invoiceCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, (error) => (error instanceof InvoiceError ? inputRefusal(error) : undefined));

/** The audit entry a managed account's create or update writes. */
const accountMetadata = (account: {
  readonly name: string;
  readonly billingCurrency: string;
  readonly costCentreIds: readonly string[];
  readonly accountIds: readonly string[];
  readonly billingProfileId: string | null;
}) => ({
  name: account.name,
  billingCurrency: account.billingCurrency,
  costCentreIds: account.costCentreIds,
  accountIds: account.accountIds,
  billingProfileId: account.billingProfileId,
});

/** One invoice, or a 404 for none. */
const findInvoice = Effect.fnUntraced(function* (organizationId: string, id: string) {
  const invoice = yield* invoiceCall(() => getInvoice(organizationId, id));
  if (!invoice) return yield* notFound();
  return invoice;
});

const ManagedAccountsHandlers = HttpApiBuilder.group(InvoicesApi, "managedAccounts", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const accounts = yield* legacy(() => listManagedAccounts(organizationId));
        return yield* respond(Schema.Array(ManagedAccount))(accounts);
      }),
    )
    // Spend in the period that no customer is billed for, by cost centre and
    // account. `invoices:read` comes first, as it always did, then the
    // endpoint's own `costs:read`, then the period.
    .handle("unassigned", ({ query }) =>
      Effect.gen(function* () {
        yield* requirePermission("invoices:read");
        const period = yield* HttpApiError.HttpApiSchemaError.wrap(
          "Query",
          Schema.decodeEffect(UnassignedPeriodQuery)(query, { errors: "all" }),
        ).pipe(Effect.orDie);
        const { organizationId } = yield* OrgPrincipal;
        const report = yield* accountCall(() => findUnassignedSpend(organizationId, period));
        return yield* respond(UnassignedSpendReport)(report);
      }),
    )
    // What moving these cost centres and accounts would do, with the spend
    // that moves with them. A dry run; nothing is written.
    .handleRaw("previewAssignment", ({ request }) =>
      Effect.gen(function* () {
        yield* requirePermission("invoices:read");
        const { periodFrom, periodTo, ...assignment } = yield* decodeAsPayload(
          ManagedAccountAssignmentPreview,
          yield* readJson(request),
        );
        const { organizationId } = yield* OrgPrincipal;
        const preview = yield* accountCall(() =>
          previewManagedAccountAssignment(organizationId, assignment, {
            from: periodFrom,
            to: periodTo,
          }),
        );
        return yield* respond(ManagedAccountAssignmentPreviewResult)(preview);
      }),
    )
    // Moves cost centres and accounts onto one customer (or off every
    // customer, with a null `managedAccountId`) in one transaction. Audited as
    // one entry listing every customer whose scope changed, before and after,
    // plus one `managed_account.update` per customer so each customer's own
    // history shows the change too.
    .handle("assign", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const changes = yield* accountCall(() =>
          assignManagedAccountScope(organizationId, payload),
        );
        if (changes.length > 0) {
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "managed_account.assign",
              entityType: "managed_account",
              entityId: payload.managedAccountId ?? "unassigned",
              metadata: {
                managedAccountId: payload.managedAccountId,
                costCentreIds: payload.costCentreIds,
                accountIds: payload.accountIds,
                changes,
              },
            }),
          );
          for (const change of changes) {
            yield* fireAndForget(() =>
              logAudit({
                organizationId,
                userId: session.userId,
                action: "managed_account.update",
                entityType: "managed_account",
                entityId: change.id,
                metadata: {
                  name: change.name,
                  via: "bulk_assignment",
                  before: change.before,
                  after: change.after,
                },
              }),
            );
          }
        }
        const accounts = yield* legacy(() => listManagedAccounts(organizationId));
        return yield* respond(ManagedAccountAssignmentResult)({ changes, accounts });
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const account = yield* legacy(() => getManagedAccount(organizationId, params.id));
        if (!account) return yield* notFound();
        return yield* respond(ManagedAccount)(account);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const account = yield* accountCall(() =>
          createManagedAccount(organizationId, payload, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "managed_account.create",
            entityType: "managed_account",
            entityId: account.id,
            metadata: accountMetadata(account),
          }),
        );
        return yield* respond(ManagedAccount)(account);
      }),
    )
    // A full replace. Editing the scope changes what future drafts are drawn
    // over and nothing else: every approved invoice holds its own copy of the
    // scope, so moving a cost centre between customers cannot re-bill a period
    // already invoiced.
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const account = yield* accountCall(() =>
          updateManagedAccount(organizationId, params.id, payload),
        );
        if (!account) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "managed_account.update",
            entityType: "managed_account",
            entityId: account.id,
            metadata: accountMetadata(account),
          }),
        );
        return yield* respond(ManagedAccount)(account);
      }),
    )
    // Soft: an issued invoice names its customer. Draft invoices go with it.
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteManagedAccount(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "managed_account.delete",
            entityType: "managed_account",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    ),
);

const InvoicesHandlers = HttpApiBuilder.group(InvoicesApi, "invoices", (handlers) =>
  handlers
    // Summaries, not full invoices: a draft's figures are recomputed on read,
    // and recomputing every draft would make opening the list one ClickHouse
    // scan per draft. A draft's `totals` is therefore null here.
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const invoices = yield* legacy(() =>
          listInvoices(organizationId, {
            managedAccountId: query.managedAccountId,
            status: query.status,
          }),
        );
        return yield* respond(Schema.Array(InvoiceSummary))(invoices);
      }),
    )
    // A draft recomputes from live spend on every read; `live: true` says so.
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const invoice = yield* findInvoice(organizationId, params.id);
        return yield* respond(Invoice)(invoice);
      }),
    )
    // The derivation as CSV: the numbers that have to survive being argued with.
    .handle("export", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const invoice = yield* findInvoice(organizationId, params.id);
        const filename = `${invoice.number ?? `draft-${invoice.id.slice(0, 8)}`}.csv`;
        return HttpServerResponse.text(renderInvoiceCsv(invoice), {
          contentType: "text/csv; charset=utf-8",
          headers: { "Content-Disposition": `attachment; filename="${filename}"` },
        });
      }),
    )
    // The document a customer files. A draft renders under a "Draft" watermark.
    .handle("pdf", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const invoice = yield* findInvoice(organizationId, params.id);
        const bytes = yield* legacy(() => renderInvoicePdfFor(organizationId, invoice));
        return HttpServerResponse.uint8Array(new Uint8Array(bytes), {
          contentType: "application/pdf",
          headers: {
            "Content-Disposition": `attachment; filename="${invoicePdfFilename(invoice)}"`,
          },
        });
      }),
    )
    // Raise a draft. Always a draft.
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const invoice = yield* invoiceCall(() =>
          createInvoice(organizationId, payload, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
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
          }),
        );
        return yield* respond(Invoice)(invoice);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const invoice = yield* invoiceCall(() => updateInvoice(organizationId, params.id, payload));
        if (!invoice) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "invoice.update",
            entityType: "invoice",
            entityId: invoice.id,
            metadata: { periodFrom: invoice.periodFrom, periodTo: invoice.periodTo },
          }),
        );
        return yield* respond(Invoice)(invoice);
      }),
    )
    // Only a draft. An issued invoice is voided, never deleted, and the service
    // refuses it independently of this route.
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* invoiceCall(() => deleteInvoice(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "invoice.delete",
            entityType: "invoice",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    )
    // The freeze. After this the figures are stored bytes: no restatement of
    // spend, no exchange-rate change, no rule edit and no rename can alter
    // what this document says.
    .handle("approve", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const invoice = yield* invoiceCall(() =>
          approveInvoice(organizationId, params.id, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
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
              // The frozen figure, in the audit entry itself: "who approved
              // what" is not answerable later if the answer requires
              // re-opening the invoice.
              billed: invoice.totals.billed,
              rateDate: invoice.derivation.rateDate,
            },
          }),
        );
        return yield* respond(Invoice)(invoice);
      }),
    )
    // Release it, and email it. Sending is irreversible in the way that
    // matters, so it rides `invoices:issue` with approving and voiding. No
    // body is the ordinary first send.
    .handleRaw("send", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { resend } = yield* decodeAsPayload(
          ManagedInvoiceSend,
          yield* readJsonOr(request, {}),
        );
        const invoice = yield* invoiceCall(() =>
          sendInvoice(organizationId, params.id, session.userId, { resend }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "invoice.send",
            entityType: "invoice",
            entityId: invoice.id,
            metadata: {
              number: invoice.number,
              managedAccountName: invoice.managedAccountName,
              resend,
              // The delivery outcome rides in the audit entry: "we sent it" is
              // not the same claim as "it arrived", and only one of them is
              // checkable later.
              deliveryStatus: invoice.delivery?.status ?? null,
              recipients: invoice.delivery?.recipients ?? [],
              delivered: invoice.delivery?.delivered ?? 0,
              deliveryError: invoice.delivery?.error ?? null,
            },
          }),
        );
        return yield* respond(Invoice)(invoice);
      }),
    )
    // Withdraw an issued invoice. With `supersede`, the corrective draft is
    // raised in the same call and linked both ways.
    .handleRaw("void", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { reason, supersede } = yield* decodeAsPayload(
          ManagedInvoiceVoid,
          yield* readJsonOr(request, {}),
        );
        const result = yield* invoiceCall(() =>
          voidInvoice(organizationId, params.id, session.userId, reason, supersede),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "invoice.void",
            entityType: "invoice",
            entityId: result.invoice.id,
            metadata: {
              number: result.invoice.number,
              reason,
              supersededByInvoiceId: result.replacement?.id ?? null,
            },
          }),
        );
        const replacement = result.replacement;
        if (replacement) {
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "invoice.create",
              entityType: "invoice",
              entityId: replacement.id,
              metadata: {
                managedAccountId: replacement.managedAccountId,
                periodFrom: replacement.periodFrom,
                periodTo: replacement.periodTo,
                supersedesInvoiceId: result.invoice.id,
              },
            }),
          );
        }
        return yield* respond(InvoiceVoidResponse)(result);
      }),
    ),
);

export const invoicesDomain = makeDomain(
  "invoices",
  InvoicesApi,
  Layer.mergeAll(ManagedAccountsHandlers, InvoicesHandlers),
);
