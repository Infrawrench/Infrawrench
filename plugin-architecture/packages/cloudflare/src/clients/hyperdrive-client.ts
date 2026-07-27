import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type { ConfigCreateParams, ConfigEditParams } from "cloudflare/resources/hyperdrive/configs";

/** URL schemes Hyperdrive accepts for an origin (`ConfigCreateParams.PublicDatabase.scheme`). */
const ORIGIN_SCHEMES = [
  "postgres",
  "postgresql",
  "mysql",
] as const satisfies readonly ConfigCreateParams.PublicDatabase["scheme"][];
type OriginScheme = (typeof ORIGIN_SCHEMES)[number];

/** The create form's default, used when no (or an unrecognised) scheme is given. */
const DEFAULT_ORIGIN_SCHEME: OriginScheme = "postgres";

function isOriginScheme(value: string): value is OriginScheme {
  return (ORIGIN_SCHEMES as readonly string[]).includes(value);
}

/**
 * The shape the Hyperdrive PATCH endpoint actually wants for a public-database
 * origin. The SDK splits `ConfigEditParams["origin"]` into four partial
 * variants — connection details (`HyperdriveHyperdriveDatabase`) and network
 * address (`HyperdriveInternetOrigin`) live in different members — so the
 * complete origin we send is their intersection.
 */
type HyperdriveOriginPatch = ConfigEditParams.HyperdriveHyperdriveDatabase &
  ConfigEditParams.HyperdriveInternetOrigin;

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
  const scheme = fields["scheme"] ?? "";
  const origin: ConfigCreateParams.PublicDatabase = {
    scheme: isOriginScheme(scheme) ? scheme : DEFAULT_ORIGIN_SCHEME,
    host: fields["host"] ?? "",
    port: Number(fields["port"] ?? 5432),
    database: fields["database"] ?? "",
    user: fields["user"] ?? "",
    password: fields["password"] ?? "",
  };
  const params: ConfigCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    origin,
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

  // Only send an `origin` patch when a connection field actually changed: the
  // edit is a PATCH that merges per-field, so touching `origin` on a name-only
  // edit is unnecessary. `fields` arrives merged with the current values, so we
  // can build a complete origin. The password is never returned by the API, so
  // we include it only when the user entered a new one — omitting it keeps the
  // existing secret.
  const changed = new Set(changedKeys);
  const originScheme = fields["originScheme"] ?? "";
  const origin: HyperdriveOriginPatch | undefined = ORIGIN_FIELD_KEYS.some((k) => changed.has(k))
    ? {
        scheme: isOriginScheme(originScheme) ? originScheme : DEFAULT_ORIGIN_SCHEME,
        host: fields["originHost"] ?? "",
        port: Number(fields["originPort"] ?? 5432),
        database: fields["database"] ?? "",
        user: fields["user"] ?? "",
        ...(fields["password"] ? { password: fields["password"] } : {}),
      }
    : undefined;

  const params: ConfigEditParams = {
    account_id,
    ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
    ...(fields["cachingDisabled"] !== undefined
      ? { caching: { disabled: fields["cachingDisabled"] === "true" } }
      : {}),
    ...(origin ? { origin } : {}),
  };

  const hd = await api.cf.hyperdrive.configs.edit(externalId, params);
  return mapHyperdrive(asRecord(hd), accountId);
}

export async function deleteHyperdrive(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.hyperdrive.configs.delete(externalId, { account_id });
}
