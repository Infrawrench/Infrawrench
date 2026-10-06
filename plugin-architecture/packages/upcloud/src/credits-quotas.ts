/**
 * Prepaid credit and quotas, both from `GET /1.3/account`.
 *
 * - `credits` is the prepaid balance in hundredths of the account currency
 *   (UpCloud prices and credits are in cents); the currency comes from
 *   `GET /account/details/{username}`.
 * - `resource_limits` gives the limits (`cores`, `memory` in MiB,
 *   `networks`, `load_balancers`, `managed_databases`,
 *   `managed_kubernetes`, `managed_object_storages`, `routers`,
 *   `detached_floating_ips`, ...). UpCloud states no usage figure, so the
 *   used half is counted from the same API's own listings; a limit whose
 *   usage cannot be listed is not reported.
 */

import type { CreditBalance, QuotaUsage } from "@infrawrench/plugin-base";
import { CreditAccessError, QuotaAccessError } from "@infrawrench/plugin-base";
import { type UpCloudApi, statusOf, unwrap } from "./api.js";
import { type Json, accountCurrency, num, str } from "./listers.js";

const HELP = { label: "Manage UpCloud users", url: "https://hub.upcloud.com/people" };

export async function fetchCredits(api: UpCloudApi): Promise<CreditBalance[]> {
  try {
    const res = await api.get<{ account?: Json }>("/account");
    const a = res.account ?? {};
    const currency = await accountCurrency(api, str(a["username"]));
    return [
      {
        key: "credits",
        label: "Prepaid credits",
        remaining: Math.max(0, num(a["credits"])) / 100,
        currency,
      },
    ];
  } catch (err) {
    const s = statusOf(err);
    if (s === 401 || s === 403) {
      throw new CreditAccessError("This UpCloud user cannot read the account balance.", HELP);
    }
    throw err;
  }
}

export async function fetchQuotas(api: UpCloudApi): Promise<QuotaUsage[]> {
  let account: Json;
  try {
    account = (await api.get<{ account?: Json }>("/account")).account ?? {};
  } catch (err) {
    const s = statusOf(err);
    if (s === 401 || s === 403)
      throw new QuotaAccessError("This UpCloud user cannot read the account limits.", HELP);
    throw err;
  }
  const limits = (account["resource_limits"] as Json | undefined) ?? {};
  const servers = unwrap<Json>(await api.get("/server"), "servers", "server");
  const networks = unwrap<Json>(await api.get("/network"), "networks", "network").filter(
    (n) => n["type"] === "private",
  );
  const routers = unwrap<Json>(await api.get("/router"), "routers", "router");
  const [lbs, dbs, k8s, oss] = await Promise.all([
    api.paged<Json>("/load-balancer"),
    api.paged<Json>("/database"),
    api.get<Json[]>("/kubernetes"),
    api.paged<Json>("/object-storage-2"),
  ]);
  const used: Record<string, [string, string, number, string?]> = {
    cores: ["Compute", "CPU cores", servers.reduce((s, x) => s + num(x["core_number"]), 0)],
    memory: ["Compute", "Memory", servers.reduce((s, x) => s + num(x["memory_amount"]), 0), "MiB"],
    networks: ["Networking", "Private networks", networks.length],
    routers: ["Networking", "Routers", routers.length],
    load_balancers: ["Load Balancers", "Load balancers", lbs.length],
    managed_databases: ["Databases", "Managed databases", dbs.length],
    managed_kubernetes: ["Kubernetes", "Kubernetes clusters", k8s.length],
    managed_object_storages: ["Object Storage", "Object Storage services", oss.length],
  };
  const out: QuotaUsage[] = [];
  for (const [key, [service, name, count, unit]] of Object.entries(used)) {
    const limit = num(limits[key]);
    if (limit <= 0) continue;
    out.push({
      id: key,
      service,
      name,
      limit,
      used: count,
      ...(unit ? { unit } : {}),
      adjustable: true,
    });
  }
  return out;
}
