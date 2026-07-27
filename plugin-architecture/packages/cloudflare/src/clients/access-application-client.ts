import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type {
  ApplicationCreateParams,
  ApplicationTypeParam,
  ApplicationUpdateParams,
} from "cloudflare/resources/zero-trust/access/applications/applications";

/**
 * Application types Access understands (`ApplicationTypeParam`). The create
 * form only offers a subset, but a stored resource can carry any of them, so
 * validate against the full set and fall back to `self_hosted` — the form
 * default and the only type that works with a bare domain.
 */
const APPLICATION_TYPES = [
  "self_hosted",
  "saas",
  "ssh",
  "vnc",
  "app_launcher",
  "warp",
  "biso",
  "bookmark",
  "dash_sso",
  "infrastructure",
  "rdp",
  "mcp",
  "mcp_portal",
  "proxy_endpoint",
] as const;

const isApplicationType = (value: string): value is ApplicationTypeParam =>
  (APPLICATION_TYPES as readonly string[]).includes(value);

function toApplicationType(value: string | undefined): ApplicationTypeParam {
  return value !== undefined && isApplicationType(value) ? value : "self_hosted";
}

function mapAccessApplication(app: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(app["id"] ?? "");
  const name = String(app["name"] ?? "");
  const domain = String(app["domain"] ?? "");
  return {
    id: `${accountId}:access-application:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "access-application",
    accountId,
    displayName: name || domain || id,
    fields: {
      name,
      domain,
      type: String(app["type"] ?? ""),
      sessionDuration: String(app["session_duration"] ?? ""),
      createdAt: String(app["created_at"] ?? ""),
      updatedAt: String(app["updated_at"] ?? ""),
    },
    resolvedOutputs: {
      aud: String(app["aud"] ?? ""),
    },
    secretStates: [],
    externalId: id,
    createdAt: String(app["created_at"] ?? new Date().toISOString()),
    updatedAt: String(app["updated_at"] ?? new Date().toISOString()),
  };
}

export async function listAccessApplications(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const app of api.cf.zeroTrust.access.applications.list({ account_id })) {
        results.push(mapAccessApplication(asRecord(app), accountId));
      }
      return results;
    },
    "Access applications",
    "Account · Access: Apps and Policies:Read",
  );
}

export async function createAccessApplication(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  // `ApplicationCreateParams` is a union of one variant per app type. Every
  // variant we expose is keyed on `domain` + `type`, which is exactly the
  // `SelfHostedApplication` shape, so name that variant instead of casting.
  const body: ApplicationCreateParams.SelfHostedApplication = {
    account_id,
    name: fields["name"] ?? "",
    domain: fields["domain"] ?? "",
    type: toApplicationType(fields["type"]),
  };
  const app = await api.cf.zeroTrust.access.applications.create(body);
  return mapAccessApplication(asRecord(app), accountId);
}

export async function editAccessApplication(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  // The Access app update is a full replace; the dispatcher hands us a merged
  // field set so domain/type are preserved when only name/session change.
  const body: ApplicationUpdateParams.SelfHostedApplication = {
    account_id,
    name: fields["name"] ?? "",
    domain: fields["domain"] ?? "",
    type: toApplicationType(fields["type"]),
    ...(fields["sessionDuration"] ? { session_duration: fields["sessionDuration"] } : {}),
  };
  const app = await api.cf.zeroTrust.access.applications.update(externalId, body);
  return mapAccessApplication(asRecord(app), accountId);
}

export async function deleteAccessApplication(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.zeroTrust.access.applications.delete(externalId, { account_id });
}
