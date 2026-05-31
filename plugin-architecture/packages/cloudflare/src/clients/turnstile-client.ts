import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { withAuthErrorHint } from "./shared.js";
import type { WidgetCreateParams } from "cloudflare/resources/turnstile/widgets";

/**
 * Cloudflare Turnstile widgets (`/accounts/{id}/challenges/widgets`) — the
 * CAPTCHA-alternative sitekey/secret pairs. The widget `sitekey` doubles as the
 * external id (it's what the embed snippet and siteverify calls reference).
 */
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
        results.push(mapWidget(w as unknown as Record<string, unknown>, accountId));
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
  const params = {
    account_id,
    name: fields["name"] ?? "",
    mode: (fields["mode"] || "managed") as "non-interactive" | "invisible" | "managed",
    domains,
    ...(fields["region"] ? { region: fields["region"] as "world" | "china" } : {}),
  } as unknown as WidgetCreateParams;
  const w = await api.cf.turnstile.widgets.create(params);
  return mapWidget(w as unknown as Record<string, unknown>, accountId);
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
  const body: Record<string, unknown> = {
    account_id,
    name: fields["name"] ?? "",
    mode: fields["mode"] || "managed",
    domains,
    ...(fields["botFightMode"] !== undefined
      ? { bot_fight_mode: fields["botFightMode"] === "true" }
      : {}),
    ...(fields["offlabel"] !== undefined ? { offlabel: fields["offlabel"] === "true" } : {}),
  };
  const w = await api.cf.turnstile.widgets.update(
    externalId,
    body as unknown as Parameters<typeof api.cf.turnstile.widgets.update>[1],
  );
  return mapWidget(w as unknown as Record<string, unknown>, accountId);
}

/** The widget secret (used by the `siteverify` endpoint). Fetched on demand. */
export async function getWidgetSecret(api: CloudflareApi, sitekey: string): Promise<string> {
  const account_id = await api.getAccountId();
  const w = (await api.cf.turnstile.widgets.get(sitekey, {
    account_id,
  })) as unknown as Record<string, unknown>;
  return String(w["secret"] ?? "");
}

export async function deleteTurnstileWidget(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.turnstile.widgets.delete(externalId, { account_id });
}
