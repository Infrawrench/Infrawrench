import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapHyperdrive(c: Record<string, unknown>, accountId: string): ResourceInstance {
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
  const cfAccountId = await api.getAccountId();
  const configs = await api.paginate<Record<string, unknown>>(
    `/accounts/${cfAccountId}/hyperdrive/configs`,
  );
  return configs.map((c) => mapHyperdrive(c, accountId));
}

export async function createHyperdrive(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const hd = await api.fetch<Record<string, unknown>>(
    `/accounts/${cfAccountId}/hyperdrive/configs`,
    {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"],
        origin: {
          scheme: fields["scheme"] ?? "postgres",
          host: fields["host"],
          port: Number(fields["port"] ?? 5432),
          database: fields["database"],
          user: fields["user"],
          password: fields["password"],
        },
      }),
    },
  );
  return mapHyperdrive(hd, accountId);
}

export async function deleteHyperdrive(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/hyperdrive/configs/${externalId}`, {
    method: "DELETE",
  });
}
