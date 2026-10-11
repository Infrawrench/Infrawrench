import type { PluginManifest } from "@infrawrench/plugin-base";
import type { ProviderOAuthInfo, ProviderOAuthResult } from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * Desktop half of provider OAuth ("Connect with X"). The main process runs the
 * flow (electron/provider-oauth/ipc.ts):
 *
 * - local workspace: the desktop's own public client, a loopback redirect,
 *   and the grant stored with the local account (refreshed in main);
 * - cloud workspace: the server's flow in the system browser, finishing on an
 *   `infrawrench://provider-oauth` link; the server stores and refreshes it.
 *
 * Which plugins can connect therefore differs by mode: locally, those with a
 * desktop client in this build; in cloud mode, those the server can run.
 */

/** Where the account lives: a cloud org, or the local workspace (null). */
export type ProviderOAuthTarget = string | null;

type ConnectResponse = ProviderOAuthResult | { cancelled: true };

function abortError(): Error {
  const e = new Error("Connection cancelled.");
  e.name = "AbortError";
  return e;
}

/**
 * Run the consent flow and resolve with the credentials to merge into the
 * form (token field, `__oauth`, and identity fields the plugin pre-filled).
 * Rejects with an `AbortError` when cancelled.
 */
export async function connectProviderOAuth(
  orgId: ProviderOAuthTarget,
  pluginId: string,
  opts: { accountId?: string } = {},
): Promise<ProviderOAuthResult> {
  const result = await invoke<ConnectResponse>("provider_oauth_connect", {
    pluginId,
    target: orgId ? "cloud" : "local",
    ...(orgId ? { orgId } : {}),
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
  });
  if ("cancelled" in result) throw abortError();
  return result;
}

export function cancelProviderOAuth(): void {
  void invoke("provider_oauth_cancel").catch(() => undefined);
}

let localClients: Promise<Set<string>> | null = null;

/** Plugin ids a local account can connect with OAuth in this build. */
export function getLocalOAuthClients(): Promise<Set<string>> {
  localClients ??= invoke<string[]>("provider_oauth_local_clients")
    .then((ids) => new Set(ids))
    .catch((err: unknown) => {
      localClients = null;
      console.error("[provider-oauth] could not list local OAuth clients:", err);
      return new Set<string>();
    });
  return localClients;
}

/**
 * `oauth` per plugin from the org's server catalog, present only where the
 * server can run the flow. Not cached across calls: the server's client
 * configuration can change while the app is open.
 */
export async function getCloudOAuthInfo(orgId: string): Promise<Map<string, ProviderOAuthInfo>> {
  const plugins = await invoke<Array<{ id: string; oauth?: ProviderOAuthInfo | null }>>(
    "cloud_list_account_plugins",
    { orgId },
  );
  const map = new Map<string, ProviderOAuthInfo>();
  for (const p of plugins) if (p.oauth) map.set(p.id, p.oauth);
  return map;
}

/** `PluginInfo.oauth` for a locally bundled manifest. */
export function localOAuthInfo(manifest: PluginManifest): ProviderOAuthInfo | undefined {
  const declaration = manifest.oauth;
  if (!declaration) return undefined;
  return {
    access: declaration.access,
    refresh: declaration.refresh,
    tokenField: declaration.tokenField,
    ...(declaration.docsUrl ? { docsUrl: declaration.docsUrl } : {}),
  };
}

/**
 * `PluginInfo.oauth` for each plugin id in this mode: the server's view for a
 * cloud org, the desktop build's for the local workspace. Never throws: a
 * failure only means no Connect button.
 */
export async function resolveOAuthInfo(
  orgId: ProviderOAuthTarget,
  manifests: PluginManifest[],
): Promise<Map<string, ProviderOAuthInfo>> {
  try {
    if (orgId) return await getCloudOAuthInfo(orgId);
    const clients = await getLocalOAuthClients();
    const map = new Map<string, ProviderOAuthInfo>();
    for (const manifest of manifests) {
      const info = clients.has(manifest.id) ? localOAuthInfo(manifest) : undefined;
      if (info) map.set(manifest.id, info);
    }
    return map;
  } catch (err) {
    console.error("[provider-oauth] could not resolve OAuth availability:", err);
    return new Map();
  }
}

/**
 * Reconnect an existing account outside the credentials editor (the
 * reconnect banner and the sidebar badge): run the flow, merge the result
 * over the stored credentials and save. The main process (local) or the
 * server (cloud) swaps in the new grant.
 */
export async function reconnectProviderAccount(
  orgId: ProviderOAuthTarget,
  accountId: string,
  pluginId: string,
): Promise<void> {
  const result = await connectProviderOAuth(orgId, pluginId, { accountId });
  if (orgId) {
    const current = await invoke<Record<string, string>>("cloud_get_account_credentials", {
      orgId,
      accountId,
    });
    await invoke("cloud_update_account_credentials", {
      orgId,
      accountId,
      credentials: { ...current, ...result.credentials },
    });
    return;
  }
  const current = await invoke<Record<string, string>>("account_get_credentials", {
    accountId,
    refresh: false,
  });
  await invoke("account_save_credentials", {
    accountId,
    credentials: { ...current, ...result.credentials },
  });
}
