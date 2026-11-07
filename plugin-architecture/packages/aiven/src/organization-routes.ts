import { ListTruncatedError } from "@infrawrench/plugin-base";
import type { AivenApi } from "./api.js";
import { enc, listOf, statusOf } from "./api.js";
import type {
  AvBillingGroupRow,
  AvInvoiceLineRow,
  AvInvoiceRow,
  AvOrganization,
  AvProjectRow,
} from "./types.js";

/**
 * The document marks the billing group, invoice and project routes for removal, in
 * favour of routes under `/organization/{organization_id}`. An old route stays first
 * while it answers, because it carries what its successor leaves out: a project's
 * default cloud and balance, a billing group's currency and balance. The token also
 * needs no organization role for it.
 */
const REMOVED = new Set([404, 405, 410]);

export async function untilRemoved<T>(
  old: () => Promise<T>,
  successor: (removal: unknown) => Promise<T>,
): Promise<T> {
  try {
    return await old();
  } catch (err) {
    if (!REMOVED.has(statusOf(err))) throw err;
    return successor(err);
  }
}

async function organizations(api: AivenApi): Promise<AvOrganization[]> {
  const res = await api.get("/organizations");
  return listOf(res?.organizations, "/organizations", "organizations");
}

/**
 * One read per organization. A user can belong to one they hold no role in, which
 * should not fail the rest, but if all of them refuse then nothing was read.
 */
async function perOrganization<T>(
  api: AivenApi,
  read: (org: AvOrganization) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let answered = false;
  let refusal: unknown;
  for (const org of await organizations(api)) {
    try {
      out.push(...(await read(org)));
      answered = true;
    } catch (err) {
      if (statusOf(err) !== 403) throw err;
      refusal = err;
    }
  }
  if (!answered && refusal) throw refusal;
  return out;
}

export function listProjects(api: AivenApi): Promise<AvProjectRow[]> {
  return untilRemoved(
    async (): Promise<AvProjectRow[]> =>
      listOf((await api.get("/project"))?.projects, "/project", "projects"),
    () =>
      perOrganization(api, async (org) => {
        const path = `/organization/${enc(org.organization_id)}/projects` as const;
        return listOf((await api.get(path))?.projects, path, "projects").map((p) => ({
          // The project's id is its name.
          project_name: p.project_id,
          organization_id: org.organization_id,
          ...(p.billing_group_id ? { billing_group_id: p.billing_group_id } : {}),
          tags: p.tags,
          tech_emails: p.tech_emails,
        }));
      }),
  );
}

export function listBillingGroups(api: AivenApi): Promise<AvBillingGroupRow[]> {
  return untilRemoved(
    async (): Promise<AvBillingGroupRow[]> =>
      listOf((await api.get("/billing-group"))?.billing_groups, "/billing-group", "billing_groups"),
    () =>
      perOrganization(api, async (org) => {
        const path = `/organization/${enc(org.organization_id)}/billing-groups` as const;
        const res = await api.get(path);
        const rows = listOf(res?.billing_groups, path, "billing_groups");
        // `next` is only set when a limit or cursor was sent, and neither is.
        if (res?.next)
          throw new ListTruncatedError({
            vendor: "Aiven",
            path,
            items: rows.length,
            maxPages: 1,
          });
        return rows.map((g) => ({
          billing_group_id: g.billing_group_id,
          billing_group_name: g.billing_group_name,
          billing_emails: g.billing_emails,
          organization_id: g.organization_id,
          account_name: org.organization_name,
          ...(g.payment_method ? { billing_type: g.payment_method.payment_method_type } : {}),
        }));
      }),
  );
}

/** An old route's billing group names its account, which `/organizations` ties to an id. */
export async function organizationOf(
  api: AivenApi,
  group: AvBillingGroupRow,
): Promise<string | undefined> {
  if (group.organization_id) return group.organization_id;
  if (!group.account_id) return undefined;
  const orgs = await organizations(api);
  return orgs.find((o) => o.account_id === group.account_id)?.organization_id;
}

export function listInvoices(api: AivenApi, group: AvBillingGroupRow): Promise<AvInvoiceRow[]> {
  const id = group.billing_group_id ?? "";
  return untilRemoved(
    async (): Promise<AvInvoiceRow[]> => {
      const path = `/billing-group/${enc(id)}/invoice` as const;
      return listOf((await api.get(path))?.invoices, path, "invoices");
    },
    async (removal) => {
      const org = await organizationOf(api, group);
      if (!org) throw removal;
      const path = `/organization/${enc(org)}/invoices` as const;
      return listOf((await api.get(path))?.invoices, path, "invoices")
        .filter((i) => i.billing_group_id === id)
        .map((i) => ({
          invoice_number: i.invoice_number,
          period_begin: i.invoice_period.begin_time,
          period_end: i.invoice_period.end_time,
          state: i.state,
          currency: i.currency,
          total_inc_vat: i.total,
          organization_id: org,
        }));
    },
  );
}

async function organizationLines(
  api: AivenApi,
  org: string,
  invoice: string,
): Promise<AvInvoiceLineRow[]> {
  const path = `/organization/${enc(org)}/invoice/${enc(invoice)}/lines` as const;
  return listOf((await api.get(path))?.lines, path, "lines").map((l) => ({
    line_type: l.line_type,
    line_total_usd: l.total_usd,
    timestamp_begin: l.begin_time,
    timestamp_end: l.end_time,
    cloud_name: l.cloud,
    service_plan: l.plan,
    project_name: l.project_id,
    service_name: l.service_id,
    service_type: l.service_type,
    description: l.description,
    tags: l.tags,
  }));
}

export function listInvoiceLines(
  api: AivenApi,
  group: AvBillingGroupRow,
  invoice: AvInvoiceRow,
): Promise<AvInvoiceLineRow[]> {
  const number = invoice.invoice_number ?? "";
  // An invoice from the organization route means the old routes have gone.
  if (invoice.organization_id) return organizationLines(api, invoice.organization_id, number);
  return untilRemoved(
    async (): Promise<AvInvoiceLineRow[]> =>
      (
        await api.get(
          `/billing-group/${enc(group.billing_group_id ?? "")}/invoice/${enc(number)}/lines`,
        )
      )?.lines ?? [],
    async (removal) => {
      const org = await organizationOf(api, group);
      if (!org) throw removal;
      return organizationLines(api, org, number);
    },
  );
}
