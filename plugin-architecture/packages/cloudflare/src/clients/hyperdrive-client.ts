import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { withAuthErrorHint } from "./shared.js";
import type { ConfigCreateParams } from "cloudflare/resources/hyperdrive/configs";

function mapHyperdrive(c: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(c["id"] ?? "");
  const name = String(c["name"] ?? "");
  const origin = c["origin"] as Record<string, unknown> | undefined;
  const caching = c["caching"] as Record<string, unknown> | undefined;
  return {
    id: `${accountId}:hyperdrive:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "hyperdrive",
    accountId,
    displayName: name || id,
    fields: {
      name,
      originHost: String(origin?.["host"] ?? ""),
      originPort: Number(origin?.["port"] ?? 0),
      originScheme: String(origin?.["scheme"] ?? ""),
      database: String(origin?.["database"] ?? ""),
      user: String(origin?.["user"] ?? ""),
      cachingDisabled: Boolean(caching?.["disabled"]),
    },
    resolvedOutputs: { hyperdriveId: id },
    secretStates: [],
    externalId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listHyperdrives(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const c of api.cf.hyperdrive.configs.list({ account_id })) {
        results.push(mapHyperdrive(c as unknown as Record<string, unknown>, accountId));
      }
      return results;
    },
    "Hyperdrive configs",
    "Account · Hyperdrive:Read",
  );
}

export async function createHyperdrive(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const origin = {
    scheme: fields["scheme"] ?? "postgres",
    host: fields["host"] ?? "",
    port: Number(fields["port"] ?? 5432),
    database: fields["database"] ?? "",
    user: fields["user"] ?? "",
    password: fields["password"] ?? "",
  };
  const params: ConfigCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    origin: origin as unknown as ConfigCreateParams["origin"],
  };
  const hd = await api.cf.hyperdrive.configs.create(params);
  return mapHyperdrive(hd as unknown as Record<string, unknown>, accountId);
}

export async function deleteHyperdrive(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.hyperdrive.configs.delete(externalId, { account_id });
}
