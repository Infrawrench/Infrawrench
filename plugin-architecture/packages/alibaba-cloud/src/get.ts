import type { ResourceInstance } from "@infrawrench/plugin-base";
import {
  getInstance,
  listAccount,
  listAlbs,
  listBuckets,
  listClusters,
  listDisks,
  listDomains,
  listEips,
  listRedis,
  listSecurityGroups,
  listSlbs,
  listSnapshots,
  listVSwitches,
  listVpcs,
  mapFunction,
  mapRds,
  nodePoolsOf,
  notFound,
  ramUserResource,
  rdsAttribute,
  recordsOf,
  splitRegional,
  type FcFunction,
  type ListContext,
} from "./listers.js";

/**
 * Fetch one resource by its external id. Uses the single-object API where
 * Alibaba has one, otherwise the type's lister narrowed to the resource's
 * region (still one region, never a fan-out).
 */
export async function getResourceByExternalId(
  ctx: ListContext,
  typeId: string,
  externalId: string,
): Promise<ResourceInstance> {
  const fromList = async (lister: (c: ListContext) => Promise<ResourceInstance[]>) => {
    const { region } = splitRegional(externalId);
    const found = (await lister({ ...ctx, regionHint: region })).find(
      (r) => r.externalId === externalId,
    );
    if (!found) throw notFound(typeId, externalId);
    return found;
  };
  switch (typeId) {
    case "account": {
      const [account] = await listAccount(ctx);
      if (!account) throw notFound(typeId, externalId);
      return account;
    }
    case "ecs-instance": {
      const { region, id } = splitRegional(externalId);
      return getInstance(ctx, region, id);
    }
    case "rds-instance": {
      const { region, id } = splitRegional(externalId);
      const attr = await rdsAttribute(ctx.api, region, id);
      if (!attr) throw notFound(typeId, externalId);
      return mapRds(ctx.accountId, region, attr);
    }
    case "fc-function": {
      const { region, id } = splitRegional(externalId);
      const fn = await ctx.api.roa<FcFunction>({
        product: "fc",
        region,
        action: "GetFunction",
        method: "GET",
        path: `/2023-03-30/functions/${id}`,
      });
      return mapFunction(ctx.accountId, region, fn);
    }
    case "ack-node-pool": {
      const [region, clusterId] = externalId.split("/");
      const found = (await nodePoolsOf(ctx, region!, clusterId!)).find(
        (r) => r.externalId === externalId,
      );
      if (!found) throw notFound(typeId, externalId);
      return found;
    }
    case "dns-domain": {
      const found = (await listDomains(ctx)).find((r) => r.externalId === externalId);
      if (!found) throw notFound(typeId, externalId);
      return found;
    }
    case "dns-record": {
      const domain = externalId.slice(0, externalId.lastIndexOf("/"));
      const found = (await recordsOf(ctx, domain)).find((r) => r.externalId === externalId);
      if (!found) throw notFound(typeId, externalId);
      return found;
    }
    case "ram-user":
      return ramUserResource(ctx, { UserName: externalId });
    case "disk":
      return fromList(listDisks);
    case "snapshot":
      return fromList(listSnapshots);
    case "vpc":
      return fromList(listVpcs);
    case "vswitch":
      return fromList(listVSwitches);
    case "security-group":
      return fromList(listSecurityGroups);
    case "eip":
      return fromList(listEips);
    case "slb":
      return fromList(listSlbs);
    case "alb":
      return fromList(listAlbs);
    case "redis-instance":
      return fromList(listRedis);
    case "oss-bucket":
      return fromList(listBuckets);
    case "ack-cluster":
      return fromList(listClusters);
    default:
      throw Object.assign(new Error(`Alibaba Cloud plugin: unknown resource type "${typeId}"`), {
        status: 400,
      });
  }
}
