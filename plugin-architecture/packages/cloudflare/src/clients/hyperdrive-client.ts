import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
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
        results.push(mapHyperdrive(asRecord(c), accountId));
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
  return mapHyperdrive(asRecord(hd), accountId);
}

/** Origin field keys (resource-field names) that, when changed, require an
 * `origin` patch. `password` is write-only and never stored, so it only ever
 * appears here when the user typed a new one. */
const ORIGIN_FIELD_KEYS = [
  "originHost",
  "originPort",
  "originScheme",
  "database",
  "user",
  "password",
];

export async function editHyperdrive(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
  changedKeys: Iterable<string> = Object.keys(fields),
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const body: Record<string, unknown> = { account_id };
  if (fields["name"] !== undefined) body["name"] = fields["name"];
  if (fields["cachingDisabled"] !== undefined) {
    body["caching"] = { disabled: fields["cachingDisabled"] === "true" };
  }

  // Only send an `origin` patch when a connection field actually changed: the
  // edit is a PATCH that merges per-field, so touching `origin` on a name-only
  // edit is unnecessary. `fields` arrives merged with the current values, so we
  // can build a complete origin. The password is never returned by the API, so
  // we include it only when the user entered a new one — omitting it keeps the
  // existing secret.
  const changed = new Set(changedKeys);
  if (ORIGIN_FIELD_KEYS.some((k) => changed.has(k))) {
    const origin: Record<string, unknown> = {
      scheme: fields["originScheme"] || "postgres",
      host: fields["originHost"] ?? "",
      port: Number(fields["originPort"] ?? 5432),
      database: fields["database"] ?? "",
      user: fields["user"] ?? "",
    };
    if (fields["password"]) origin["password"] = fields["password"];
    body["origin"] = origin;
  }

  const hd = await api.cf.hyperdrive.configs.edit(
    externalId,
    body as unknown as Parameters<typeof api.cf.hyperdrive.configs.edit>[1],
  );
  return mapHyperdrive(asRecord(hd), accountId);
}

export async function deleteHyperdrive(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.hyperdrive.configs.delete(externalId, { account_id });
}
