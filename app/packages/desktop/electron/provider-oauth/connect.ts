/**
 * Provider OAuth ("Connect with X") for the desktop GUI, served as the
 * `ProviderOAuth*` RPCs (`shared/rpc/groups/provider-oauth.ts`).
 *
 * `target: "local"` runs the native-app flow here (loopback redirect, PKCE,
 * public client) and returns the token plus plain grant state, which the
 * account create/save credential calls store. `target: "cloud"` asks the
 * server to run its flow, opens the browser, and waits for the server's
 * `infrawrench://provider-oauth` deep link (routed here by `./routes.ts`);
 * its `__oauth` is a sealed grant the server unseals on save.
 *
 * One flow at a time: starting another cancels the first. No import-time
 * side effects; `./routes.ts` does the protocol and status wiring.
 */
import { shell } from "electron";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import {
  applyOAuthTokens,
  exchangeOAuthCode,
  OAUTH_CREDENTIAL_KEY,
  readOAuthGrantState,
  type OAuthExchangeRequest,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { errorMessage } from "../../shared/rpc/errors";
import {
  ProviderOAuthCancelled,
  ProviderOAuthError,
  type ProviderOAuthStatusChange,
} from "../../shared/rpc/groups/provider-oauth";
import { cloudFetch } from "../cloud-data/shared";
import { loadPlugins, getPlugin } from "../infrafile/plugins";
import { getDesktopOAuthClientId } from "./build-env";
import { localClientPluginIds, localClientSource } from "./client-source";
import { runLoopbackAuthorization, LoopbackFlowError, LOOPBACK_TIMEOUT_MS } from "./loopback";
import {
  deliverToPendingFlow,
  type PendingCloudFlow,
  type ProviderOAuthPayload,
} from "./deep-link";

export interface ProviderOAuthConnectResult {
  credentials: Record<string, string>;
  accountName?: string;
}

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
      const request: OAuthExchangeRequest = {
        code,
        codeVerifier,
        redirectUri,
        client: client.clientSecret
          ? {
              clientId: client.clientId,
              clientSecret: client.clientSecret,
              auth: "client_secret_post",
            }
          : { clientId: client.clientId, auth: "none" },
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

/** A provider-oauth link from `./routes.ts`; false when no cloud flow was waiting for it. */
export function deliverProviderOAuthResult(payload: ProviderOAuthPayload): boolean {
  return deliverToPendingFlow(pendingCloud, payload);
}

const statusSubscribers = new Set<(change: typeof ProviderOAuthStatusChange.Type) => void>();

/** A local account's connection changed state: tell every subscribed window. */
export function publishOAuthStatus(change: typeof ProviderOAuthStatusChange.Type): void {
  for (const subscriber of statusSubscribers) subscriber(change);
}

type ConnectRequest =
  | { readonly target: "local"; readonly pluginId: string }
  | {
      readonly target: "cloud";
      readonly pluginId: string;
      readonly orgId: string;
      readonly accountId?: string;
    };

/**
 * One flow. The call's own interruption cancels it too, so a renderer that
 * goes away does not leave a loopback listener or a pending cloud flow behind.
 */
const connect = (
  request: ConnectRequest,
): Effect.Effect<ProviderOAuthConnectResult, ProviderOAuthError | ProviderOAuthCancelled> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      cancelCurrent();
      const controller = new AbortController();
      current = controller;
      return controller;
    }),
    (controller) =>
      Effect.tryPromise({
        try: () =>
          request.target === "cloud"
            ? connectCloud(request.pluginId, request.orgId, request.accountId, controller.signal)
            : connectLocal(request.pluginId, controller.signal),
        catch: (cause) =>
          cause instanceof LoopbackFlowError && cause.reason === "cancelled"
            ? new ProviderOAuthCancelled({ message: cause.message })
            : new ProviderOAuthError({ message: errorMessage(cause) }),
      }),
    (controller, exit) =>
      Effect.sync(() => {
        if (exit._tag === "Failure" && !controller.signal.aborted) controller.abort();
        if (current === controller) current = null;
      }),
  );

export class ProviderOAuth extends Context.Service<
  ProviderOAuth,
  {
    readonly localClients: Effect.Effect<string[]>;
    readonly connect: typeof connect;
    readonly cancel: Effect.Effect<void>;
    readonly statusChanges: Stream.Stream<typeof ProviderOAuthStatusChange.Type>;
  }
>()("infrawrench/desktop/ProviderOAuth") {
  static readonly layer = Layer.succeed(ProviderOAuth)(
    ProviderOAuth.of({
      localClients: Effect.promise(() => localPluginIds()),
      connect,
      cancel: Effect.sync(cancelCurrent),
      statusChanges: Stream.callback<typeof ProviderOAuthStatusChange.Type>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const subscriber = (change: typeof ProviderOAuthStatusChange.Type) => {
              Queue.offerUnsafe(queue, change);
            };
            statusSubscribers.add(subscriber);
            return subscriber;
          }),
          (subscriber) => Effect.sync(() => statusSubscribers.delete(subscriber)),
        ),
      ),
    }),
  );
}
