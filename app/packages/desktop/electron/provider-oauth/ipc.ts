/**
 * Provider OAuth ("Connect with X") IPC for the desktop GUI.
 *
 * - `provider_oauth_local_clients`: plugins a LOCAL account can connect: the
 *   manifest declares a desktop client and this build carries its client id.
 * - `provider_oauth_connect`: run one flow and return the credentials to
 *   merge into the form. `target: "local"` runs the native-app flow here
 *   (loopback redirect, PKCE, public client) and returns the token plus plain
 *   grant state, which `account_create` / `account_save_credentials` store.
 *   `target: "cloud"` asks the server to run its flow, opens the browser, and
 *   waits for the server's `infrawrench://provider-oauth` deep link; its
 *   `__oauth` is a sealed grant the server unseals on save.
 * - `provider_oauth_cancel`: abandon the running flow.
 *
 * One flow at a time: starting another cancels the first.
 */
import { BrowserWindow, ipcMain, shell } from "electron";
import { z } from "zod";
import {
  applyOAuthTokens,
  exchangeOAuthCode,
  OAUTH_CREDENTIAL_KEY,
  readOAuthGrantState,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { cloudFetch } from "../cloud-data/shared";
import { registerProtocolRoute } from "../cloud-auth";
import { loadPlugins, getPlugin } from "../infrafile/plugins";
import { getDesktopOAuthClientId } from "./build-env";
import { localClientPluginIds, localClientSource } from "./client-source";
import { runLoopbackAuthorization, LoopbackFlowError, LOOPBACK_TIMEOUT_MS } from "./loopback";
import {
  PROVIDER_OAUTH_DEEP_LINK_HOST,
  deliverToPendingFlow,
  parseProviderOAuthDeepLink,
  type PendingCloudFlow,
  type ProviderOAuthPayload,
} from "./deep-link";
import { setOAuthStatusListener } from "./local-accounts";

export interface ProviderOAuthConnectResult {
  credentials: Record<string, string>;
  accountName?: string;
}

const ConnectArgs = z.object({
  pluginId: z.string().min(1).max(128),
  target: z.enum(["local", "cloud"]),
  orgId: z.string().min(1).max(128).optional(),
  accountId: z.string().min(1).max(128).optional(),
});

let current: AbortController | null = null;
let pendingCloud: PendingCloudFlow | null = null;

function cancelCurrent(): void {
  current?.abort();
  current = null;
}

function localPluginIds(): Promise<string[]> {
  return loadPlugins().then((plugins) =>
    localClientPluginIds(
      plugins.map((p) => p.plugin),
      getDesktopOAuthClientId,
    ),
  );
}

async function connectLocal(
  pluginId: string,
  signal: AbortSignal,
): Promise<ProviderOAuthConnectResult> {
  const doFetch: typeof fetch = (input, init) => fetch(input, init);
  const loaded = await getPlugin(pluginId);
  const declaration = loaded?.plugin.manifest.oauth;
  const clientSource = loaded
    ? localClientSource(loaded.plugin, getDesktopOAuthClientId, doFetch)
    : null;
  if (!loaded || !declaration || !clientSource) {
    throw new Error(
      `${loaded?.plugin.manifest.displayName ?? pluginId} cannot be connected from this app.`,
    );
  }
  const { plugin } = loaded;
  const providerName = plugin.manifest.displayName;
  const pluginAuthorizeUrl = plugin.buildOAuthAuthorizeUrl?.bind(plugin);

  return runLoopbackAuthorization({
    declaration,
    client: clientSource,
    ...(pluginAuthorizeUrl ? { buildAuthorizeUrl: pluginAuthorizeUrl } : {}),
    providerName,
    signal,
    openExternal: (url) => shell.openExternal(url),
    onCode: async ({ code, codeVerifier, redirectUri, client }) => {
      const request = {
        code,
        codeVerifier,
        redirectUri,
        client: client.clientSecret
          ? {
              clientId: client.clientId,
              clientSecret: client.clientSecret,
              auth: "client_secret_post" as const,
            }
          : { clientId: client.clientId, auth: "none" as const },
        fetch: doFetch,
      };
      const tokens: OAuthTokenSet = plugin.exchangeOAuthCode
        ? await plugin.exchangeOAuthCode(request)
        : await exchangeOAuthCode(declaration, request);
      const completion = plugin.completeOAuthConnection
        ? await plugin.completeOAuthConnection(tokens, { client: "desktop", fetch: doFetch })
        : {};
      // Plugin-discovered fields first; the host owns the token field and
      // the grant state, so a hook cannot overwrite either.
      const credentials: Record<string, string> = {};
      for (const [key, value] of Object.entries(completion.credentials ?? {})) {
        if (key !== declaration.tokenField && key !== OAUTH_CREDENTIAL_KEY) {
          credentials[key] = value;
        }
      }
      applyOAuthTokens(declaration, credentials, tokens, "desktop");
      if (declaration.clientRegistration === "dynamic") {
        // Refreshes must use the client this grant was issued to, secret
        // included when the registration issued one. Both are stored in the
        // encrypted local credentials, and account_get_credentials hands the
        // renderer a copy without the secret (redactGrantForRenderer).
        const state = readOAuthGrantState(credentials);
        if (state) {
          credentials[OAUTH_CREDENTIAL_KEY] = JSON.stringify({
            ...state,
            clientId: client.clientId,
            ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
          });
        }
      }
      return {
        credentials,
        ...(completion.accountName ? { accountName: completion.accountName } : {}),
      };
    },
  });
}

async function connectCloud(
  pluginId: string,
  orgId: string,
  accountId: string | undefined,
  signal: AbortSignal,
): Promise<ProviderOAuthConnectResult> {
  const started = await cloudFetch<{ url: string }>(
    orgId,
    `/provider-oauth/${encodeURIComponent(pluginId)}/authorize`,
    {
      method: "POST",
      body: JSON.stringify({ returnTo: "desktop", ...(accountId ? { accountId } : {}) }),
    },
  );
  if (!started?.url) throw new Error("Infrawrench Cloud did not return a sign-in URL.");
  const authorizeUrl = new URL(started.url);
  if (authorizeUrl.protocol !== "https:" && authorizeUrl.protocol !== "http:") {
    throw new Error("Infrawrench Cloud returned an unexpected sign-in URL.");
  }

  const payload = await new Promise<ProviderOAuthPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      reject(
        new LoopbackFlowError(
          "Timed out waiting for the connection to finish. Start it again when you are ready.",
          "timeout",
        ),
      );
    }, LOOPBACK_TIMEOUT_MS);
    const onAbort = () => {
      done();
      reject(new LoopbackFlowError("Connection cancelled.", "cancelled"));
    };
    const flow: PendingCloudFlow = {
      pluginId,
      ...(accountId ? { accountId } : {}),
      resolve: (result) => {
        done();
        resolve(result);
      },
    };
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (pendingCloud === flow) pendingCloud = null;
    }
    pendingCloud = flow;
    signal.addEventListener("abort", onAbort);
    void shell.openExternal(authorizeUrl.toString()).catch((err: unknown) => {
      done();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  if (!payload.ok) throw new Error(payload.error);
  return {
    credentials: payload.credentials,
    ...(payload.accountName ? { accountName: payload.accountName } : {}),
  };
}

registerProtocolRoute(PROVIDER_OAUTH_DEEP_LINK_HOST, (url) => {
  const payload = parseProviderOAuthDeepLink(url);
  if (!payload) {
    console.warn("[provider-oauth] ignored a malformed provider-oauth link");
    return;
  }
  if (!deliverToPendingFlow(pendingCloud, payload)) {
    console.warn("[provider-oauth] ignored a provider-oauth result nothing was waiting for");
  }
});

// A refresh that the provider rejected (or a successful reconnect) changes
// what the sidebar and account page should show.
setOAuthStatusListener((accountId, status) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("provider_oauth_status", { accountId, status });
    }
  }
});

ipcMain.handle("provider_oauth_local_clients", () => localPluginIds());

/**
 * Resolves `{ cancelled: true }` instead of rejecting when the user (or a
 * newer flow) cancelled, so the renderer can go quietly back to idle: an
 * error's class does not survive the IPC boundary.
 */
ipcMain.handle(
  "provider_oauth_connect",
  async (_e, raw: unknown): Promise<ProviderOAuthConnectResult | { cancelled: true }> => {
    const { pluginId, target, orgId, accountId } = ConnectArgs.parse(raw);
    cancelCurrent();
    const controller = new AbortController();
    current = controller;
    try {
      if (target === "cloud") {
        if (!orgId) throw new Error("provider_oauth_connect: orgId is required for cloud accounts");
        return await connectCloud(pluginId, orgId, accountId, controller.signal);
      }
      return await connectLocal(pluginId, controller.signal);
    } catch (err) {
      if (err instanceof LoopbackFlowError && err.reason === "cancelled") {
        return { cancelled: true };
      }
      throw err;
    } finally {
      if (current === controller) current = null;
    }
  },
);

ipcMain.handle("provider_oauth_cancel", () => {
  cancelCurrent();
  return { ok: true };
});
