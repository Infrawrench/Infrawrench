/**
 * Extra reads for a detail view, stashed as `resolvedOutputs.__name__` JSON
 * for the synchronous renderer. Each read is best-effort: a failure leaves
 * that stash absent and the view renders without it.
 */

import type { ImageOption, ResourceInstance } from "@infrawrench/plugin-base";
import { type LinodeApi, trailingId } from "./api.js";
import { linodeSizeOptions } from "./create.js";
import type { PriceCatalogCache } from "./pricing.js";
import type {
  LinodeAccount,
  LinodeFirewall,
  LinodeImage,
  LinodeInvoiceItem,
  LinodeNodeBalancerConfig,
  LinodeTransfer,
  LinodeVpc,
} from "./types.js";

async function tryGet<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function enrichDetail(
  api: LinodeApi,
  catalog: PriceCatalogCache,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const stash: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    if (value != null) stash[`__${key}__`] = JSON.stringify(value);
  };
  const id = trailingId(resource.id);

  switch (resource.resourceTypeId) {
    case "linode": {
      const [prices, images, backups, transfer] = await Promise.all([
        tryGet(catalog.get()),
        tryGet(api.all<LinodeImage>("/images")),
        resource.fields["backupsEnabled"] === true
          ? tryGet(
              api.get<{
                automatic?: Array<{
                  id: number;
                  label?: string | null;
                  created?: string;
                  status?: string;
                  available?: boolean;
                }>;
                snapshot?: {
                  current?: {
                    id: number;
                    label?: string | null;
                    created?: string;
                    available?: boolean;
                  } | null;
                };
              }>(`/linode/instances/${id}/backups`),
            )
          : Promise.resolve(null),
        tryGet(api.get<LinodeTransfer>(`/linode/instances/${id}/transfer`)),
      ]);
      if (prices) {
        const region = String(resource.fields["region"] ?? "");
        // Quote the plans at this Linode's own regional price.
        put(
          "plans",
          linodeSizeOptions(prices, { excludeGpu: false }).map((s) => {
            const t = prices.linodeTypes.find((x) => x.id === s.id);
            const rp = t?.region_prices?.find((p) => p.id === region)?.monthly;
            return rp != null ? { ...s, priceMonthly: rp } : s;
          }),
        );
      }
      if (images) {
        const opts: ImageOption[] = images
          .filter((i) => i.status === "available" && !i.deprecated)
          .map((i) => ({
            id: i.id,
            label: i.label ?? i.id,
            category: i.is_public ? (i.vendor ?? "Other") : "My Images",
            isOwned: i.is_public !== true,
          }));
        put("images", opts);
      }
      if (backups) {
        const list = [
          ...(backups.snapshot?.current ? [backups.snapshot.current] : []),
          ...(backups.automatic ?? []),
        ]
          .filter((b) => b.available !== false)
          .map((b) => ({
            id: b.id,
            label: `${b.label || "Automatic backup"} (${(b.created ?? "").slice(0, 16).replace("T", " ")})`,
          }));
        put("backups", list);
      }
      put("transfer", transfer);
      break;
    }
    case "nodebalancer": {
      const configs = await tryGet(
        api.all<LinodeNodeBalancerConfig>(`/nodebalancers/${id}/configs`),
      );
      if (configs) {
        const withNodes = await Promise.all(
          configs.map(async (c) => {
            const nodes =
              (await tryGet(
                api.all<{
                  id: number;
                  label?: string;
                  address?: string;
                  status?: string;
                  weight?: number;
                  mode?: string;
                }>(`/nodebalancers/${id}/configs/${c.id}/nodes`),
              )) ?? [];
            return {
              id: c.id,
              port: c.port ?? 0,
              protocol: c.protocol ?? "",
              algorithm: c.algorithm ?? "",
              check: c.check ?? "",
              nodes: nodes.map((n) => ({
                id: n.id,
                label: n.label ?? "",
                address: n.address ?? "",
                status: n.status ?? "",
                weight: n.weight ?? 0,
                mode: n.mode ?? "",
              })),
            };
          }),
        );
        put("configs", withNodes);
      }
      break;
    }
    case "firewall": {
      const [fw, devices] = await Promise.all([
        tryGet(api.get<LinodeFirewall>(`/networking/firewalls/${id}`)),
        tryGet(
          api.all<{ id: number; entity?: { id?: number; label?: string; type?: string } }>(
            `/networking/firewalls/${id}/devices`,
          ),
        ),
      ]);
      if (fw?.rules)
        put("rules", { inbound: fw.rules.inbound ?? [], outbound: fw.rules.outbound ?? [] });
      if (devices) {
        put(
          "devices",
          devices.map((d) => ({
            deviceId: d.id,
            id: d.entity?.id ?? 0,
            label: d.entity?.label ?? String(d.entity?.id ?? d.id),
            type: d.entity?.type ?? "",
          })),
        );
      }
      break;
    }
    case "vpc": {
      const vpc = await tryGet(api.get<LinodeVpc>(`/vpcs/${id}`));
      if (vpc) {
        put(
          "subnets",
          (vpc.subnets ?? []).map((s) => ({
            id: s.id ?? 0,
            label: s.label ?? "",
            ipv4: s.ipv4 ?? "",
            linodes: s.linodes?.length ?? 0,
          })),
        );
      }
      break;
    }
    case "account": {
      const [account, transfer] = await Promise.all([
        tryGet(api.get<LinodeAccount>("/account")),
        tryGet(api.get<LinodeTransfer>("/account/transfer")),
      ]);
      if (account) put("promotions", account.active_promotions ?? []);
      if (transfer) put("regionTransfers", transfer.region_transfers ?? []);
      break;
    }
    case "invoice": {
      put("items", await tryGet(api.all<LinodeInvoiceItem>(`/account/invoices/${id}/items`)));
      break;
    }
    default:
      return resource;
  }
  return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...stash } };
}
