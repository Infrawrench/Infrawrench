import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { AnyscaleApi, AsCloud, AsUsageByCluster, PageQuery } from "./api.js";
import { isPermissionError, listPages } from "./api.js";

/**
 * Anyscale's own charges, read from the usage dashboard's data
 * (`POST /api/v2/aggregated_instance_usage/cluster`, the per-cluster daily
 * breakdown behind Organization settings > Usage and the
 * `anyscale aggregated-instance-usage` CLI).
 *
 * What the numbers are, and why nothing is counted twice:
 *
 * - On a **customer-hosted** cloud (your AWS account, Google Cloud project or
 *   Kubernetes cluster) the machines are billed by that provider directly and
 *   already land in the AWS / GCP / Azure plugins' costs. Anyscale's usage
 *   data carries only Anyscale's platform charge (credits per instance-hour),
 *   never the instance cost: Anyscale's price list says so in as many words
 *   ("does not include your cloud compute costs").
 * - On an **Anyscale-hosted** cloud there is no other bill: the credits cover
 *   the compute, and Anyscale is the only place it appears.
 *
 * So every row here is money Anyscale invoices, and the `hosting` tag tells
 * the two apart. `dollar_value` is Anyscale's estimate at the organization's
 * contracted rate; the credit quantity rides along as `usageAmount`.
 */

const PAGE = 1000;
const MAX_PAGES = 200;
export const CREDIT_UNIT = "Anyscale credits";

const HELP = {
  label: "Anyscale organization roles",
  url: "https://docs.anyscale.com/administration/organization/permissions",
};

/** Which kind of workload a cluster ran, from the id the usage row carries. */
export function clusterTypeOf(row: {
  workspace_id?: string | null;
  service_id?: string | null;
  job_id?: string | null;
}): "Workspace" | "Service" | "Job" | "Cluster" {
  if (row.workspace_id) return "Workspace";
  if (row.service_id) return "Service";
  if (row.job_id) return "Job";
  return "Cluster";
}

export interface CloudInfo {
  name: string;
  region: string;
  hosting: "anyscale-hosted" | "customer-cloud";
}

/** Cloud id → region and hosting model, for the region dimension and the tag. */
export async function cloudDirectory(api: AnyscaleApi): Promise<Map<string, CloudInfo>> {
  const clouds = await listPages(5, 1000, (query) => api.get("/api/v2/clouds/", { query })).catch(
    (): AsCloud[] => [],
  );
  const out = new Map<string, CloudInfo>();
  for (const c of clouds) {
    if (!c.id) continue;
    out.set(c.id, {
      name: c.name ?? c.id,
      region: c.region ?? "",
      hosting: c.is_aioa ? "anyscale-hosted" : "customer-cloud",
    });
  }
  return out;
}

function rethrow(err: unknown): never {
  if (isPermissionError(err)) {
    throw new CostSetupError(
      "Anyscale only shows usage and cost to organization owners. Use an API key belonging to an organization owner, or a service account with the Owner role.",
      HELP,
    );
  }
  throw err;
}

/** Map one usage row to a cost row; null when it carries nothing. */
export function usageRowToCost(
  row: AsUsageByCluster,
  clouds: Map<string, CloudInfo>,
): CostRow | null {
  const date = (row.date ?? "").slice(0, 10);
  if (!date) return null;
  const amount = Number(row.dollar_value ?? 0);
  const credits = Number(row.anyscale_credits ?? 0);
  if (!amount && !credits) return null;
  const type = clusterTypeOf(row);
  const cloud = row.cloud_id ? clouds.get(row.cloud_id) : undefined;
  const workloadId = row.workspace_id ?? row.service_id ?? row.job_id ?? row.cluster_id ?? "";
  const workloadName = row.workspace_name ?? row.service_name ?? row.job_name ?? "";
  const tags: Record<string, string> = { clusterType: type.toLowerCase() };
  const put = (k: string, v: string | null | undefined) => {
    if (v) tags[k] = v;
  };
  put("project", row.project_name);
  put("cloud", row.cloud_name ?? cloud?.name);
  put("user", row.user_email ?? row.user_name);
  put("workload", workloadName);
  put("jobQueue", row.job_queue_name);
  put("hosting", cloud?.hosting);
  return {
    date,
    service: type,
    ...(cloud?.region ? { region: cloud.region } : {}),
    ...(workloadId ? { resourceId: workloadId } : {}),
    tags,
    currency: "USD",
    amount: Number.isFinite(amount) ? amount : 0,
    ...(credits ? { usageAmount: credits, usageUnit: CREDIT_UNIT } : {}),
  };
}

/** Sum rows that share every dimension (the API can split a day per cluster). */
export function aggregateCostRows(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>();
  for (const r of rows) {
    const key = JSON.stringify([r.date, r.service, r.region, r.resourceId, r.tags]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    prev.amount += r.amount;
    if (r.usageAmount !== undefined) {
      prev.usageAmount = (prev.usageAmount ?? 0) + r.usageAmount;
      prev.usageUnit = CREDIT_UNIT;
    }
  }
  return [...byKey.values()];
}

export async function fetchAnyscaleCostData(
  api: AnyscaleApi,
  range: CostFetchRange,
): Promise<CostRow[]> {
  let usage: AsUsageByCluster[];
  try {
    usage = await listPages(MAX_PAGES, PAGE, (query) =>
      api.post("/api/v2/aggregated_instance_usage/cluster", {
        query,
        body: {
          start_date: range.fromDate,
          end_date: range.toDate,
          group_by_date: true,
          asc: true,
        },
      }),
    );
  } catch (err) {
    rethrow(err);
  }
  const clouds = await cloudDirectory(api);
  const rows: CostRow[] = [];
  for (const u of usage) {
    const row = usageRowToCost(u, clouds);
    if (row && row.date >= range.fromDate && row.date <= range.toDate) rows.push(row);
  }
  return aggregateCostRows(rows);
}

export interface UsageBreakdownLine {
  label: string;
  dollars: number;
  credits: number;
}

/** A usage row once one grouping has given it a label. */
interface LabelledUsage {
  label: string;
  dollar_value?: number | null;
  anyscale_credits?: number | null;
}

/** One grouping's rows, each labelled the way that grouping reads. */
async function labelledUsage(
  api: AnyscaleApi,
  group: "cluster_type" | "project" | "user",
  fromDate: string,
  toDate: string,
): Promise<LabelledUsage[]> {
  const page = (query: PageQuery) => ({
    query,
    body: { start_date: fromDate, end_date: toDate, group_by_date: false },
  });
  switch (group) {
    case "cluster_type":
      return (
        await listPages(5, PAGE, (query) =>
          api.post("/api/v2/aggregated_instance_usage/cluster_type", page(query)),
        )
      ).map((r) => ({ ...r, label: r.cluster_type ?? "Other" }));
    case "project":
      return (
        await listPages(5, PAGE, (query) =>
          api.post("/api/v2/aggregated_instance_usage/project", page(query)),
        )
      ).map((r) => ({
        ...r,
        label: [r.project_name, r.cloud_name].filter(Boolean).join(" / ") || "Unknown project",
      }));
    case "user":
      return (
        await listPages(5, PAGE, (query) =>
          api.post("/api/v2/aggregated_instance_usage/user", page(query)),
        )
      ).map((r) => ({ ...r, label: r.user_email ?? r.user_name ?? "Unknown user" }));
  }
}

/** Totals over a window grouped one way, largest first: for detail views. */
export async function fetchUsageBreakdown(
  api: AnyscaleApi,
  group: "cluster_type" | "project" | "user",
  fromDate: string,
  toDate: string,
): Promise<UsageBreakdownLine[]> {
  const rows = await labelledUsage(api, group, fromDate, toDate);
  const totals = new Map<string, UsageBreakdownLine>();
  for (const r of rows) {
    const line = totals.get(r.label) ?? { label: r.label, dollars: 0, credits: 0 };
    line.dollars += Number(r.dollar_value ?? 0);
    line.credits += Number(r.anyscale_credits ?? 0);
    totals.set(r.label, line);
  }
  return [...totals.values()].sort((a, b) => b.dollars - a.dollars);
}

/** Organization total over a window: `GET /api/v2/aggregated_instance_usage/`. */
export async function fetchTotalUsage(
  api: AnyscaleApi,
  fromDate: string,
  toDate: string,
): Promise<{ dollars: number; credits: number }> {
  const res = await api.get("/api/v2/aggregated_instance_usage/", {
    query: { start_date: fromDate, end_date: toDate },
  });
  return {
    dollars: Number(res.result?.dollar_value ?? 0),
    credits: Number(res.result?.anyscale_credits ?? 0),
  };
}

/** Daily spend per workload over a window, keyed by workload id. */
export async function fetchWorkloadSpend(
  api: AnyscaleApi,
  nameContains: string,
  fromDate: string,
  toDate: string,
): Promise<AsUsageByCluster[]> {
  return listPages(10, PAGE, (query) =>
    api.post("/api/v2/aggregated_instance_usage/cluster", {
      query,
      body: {
        start_date: fromDate,
        end_date: toDate,
        group_by_date: true,
        asc: true,
        ...(nameContains ? { name_contains: nameContains } : {}),
      },
    }),
  );
}
