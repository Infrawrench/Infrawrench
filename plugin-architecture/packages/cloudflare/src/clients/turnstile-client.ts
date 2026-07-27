import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type {
  WidgetCreateParams,
  WidgetUpdateParams,
} from "cloudflare/resources/turnstile/widgets";

/**
 * Cloudflare Turnstile widgets (`/accounts/{id}/challenges/widgets`) — the
 * CAPTCHA-alternative sitekey/secret pairs. The widget `sitekey` doubles as the
 * external id (it's what the embed snippet and siteverify calls reference).
 */

/** Widget modes the API accepts (`WidgetCreateParams.mode`). */
const WIDGET_MODES = [
  "non-interactive",
  "invisible",
  "managed",
] as const satisfies readonly WidgetCreateParams["mode"][];
type WidgetMode = (typeof WIDGET_MODES)[number];

/** Cloudflare's own recommended default, and the create form's default value. */
const DEFAULT_WIDGET_MODE: WidgetMode = "managed";

function isWidgetMode(value: string): value is WidgetMode {
  return (WIDGET_MODES as readonly string[]).includes(value);
}

/** Widget regions the API accepts (`WidgetCreateParams.region`). */
const WIDGET_REGIONS = ["world", "china"] as const satisfies readonly NonNullable<
  WidgetCreateParams["region"]
>[];
type WidgetRegion = (typeof WIDGET_REGIONS)[number];

/** An unrecognised region is dropped: the API defaults to `world`. */
function isWidgetRegion(value: string): value is WidgetRegion {
  return (WIDGET_REGIONS as readonly string[]).includes(value);
}

function mapWidget(w: Record<string, unknown>, accountId: string): ResourceInstance {
  const sitekey = String(w["sitekey"] ?? "");
  const name = String(w["name"] ?? "");
  const domains = Array.isArray(w["domains"]) ? (w["domains"] as string[]).join(", ") : "";
  return {
    id: `${accountId}:turnstile-widget:${sitekey}`,
    pluginId: "cloudflare",
    resourceTypeId: "turnstile-widget",
    accountId,
    displayName: name || sitekey,
    fields: {
      name,
      mode: String(w["mode"] ?? ""),
      domains,
      region: String(w["region"] ?? "world"),
      botFightMode: Boolean(w["bot_fight_mode"]),
      clearanceLevel: String(w["clearance_level"] ?? ""),
      offlabel: Boolean(w["offlabel"]),
    },
    resolvedOutputs: { siteKey: sitekey },
    secretStates: [],
    externalId: sitekey,
    createdAt: String(w["created_on"] ?? new Date().toISOString()),
    updatedAt: String(w["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listTurnstileWidgets(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const w of api.cf.turnstile.widgets.list({ account_id })) {
        results.push(mapWidget(asRecord(w), accountId));
      }
      return results;
    },
    "Turnstile widgets",
    "Account · Turnstile:Read",
  );
}

export async function createTurnstileWidget(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const domains = (fields["domains"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = fields["mode"] ?? "";
  const region = fields["region"] ?? "";
  const params: WidgetCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    mode: isWidgetMode(mode) ? mode : DEFAULT_WIDGET_MODE,
    domains,
    ...(isWidgetRegion(region) ? { region } : {}),
  };
  const w = await api.cf.turnstile.widgets.create(params);
  return mapWidget(asRecord(w), accountId);
}

export async function editTurnstileWidget(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  // The update is a full replace; the dispatcher hands us a merged field set.
  const domains = (fields["domains"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = fields["mode"] ?? "";
  const params: WidgetUpdateParams = {
    account_id,
    name: fields["name"] ?? "",
    mode: isWidgetMode(mode) ? mode : DEFAULT_WIDGET_MODE,
    domains,
    ...(fields["botFightMode"] !== undefined
      ? { bot_fight_mode: fields["botFightMode"] === "true" }
      : {}),
    ...(fields["offlabel"] !== undefined ? { offlabel: fields["offlabel"] === "true" } : {}),
  };
  const w = await api.cf.turnstile.widgets.update(externalId, params);
  return mapWidget(asRecord(w), accountId);
}

/** The widget secret (used by the `siteverify` endpoint). Fetched on demand. */
export async function getWidgetSecret(api: CloudflareApi, sitekey: string): Promise<string> {
  const account_id = await api.getAccountId();
  const w = asRecord(
    await api.cf.turnstile.widgets.get(sitekey, {
      account_id,
    }),
  );
  return String(w["secret"] ?? "");
}

export async function deleteTurnstileWidget(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.turnstile.widgets.delete(externalId, { account_id });
}
