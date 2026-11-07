/**
 * The types of the Effect contract, and only types: every import below is
 * `import type`, so `@infrawrench/plugin-base`'s root entry costs its consumers
 * (the SPA, mobile) no Effect runtime. The runtime half is
 * `@infrawrench/plugin-base/effect`.
 */
import type { Effect, Stream } from "effect";
import type { CostSetupError } from "./cost.js";
import type { CreditAccessError } from "./credits.js";
import type { PluginError } from "./effect.js";
import type { AiRequestLogSetupError } from "./ai-requests.js";
import type { IdleFindingAccessError } from "./idle-findings.js";
import type { HostServices, Plugin, PluginClient } from "./manifest.js";
import type { NetworkFlowSetupError } from "./network-flow.js";
import type { OAuthTokenError } from "./oauth.js";
import type { QuotaAccessError } from "./quotas.js";
import type { VulnerabilityAccessError } from "./vulnerabilities.js";

/** Everything a plugin operation can fail with. Each member carries a `_tag`. */
export type PluginFailure =
  | PluginError
  | AiRequestLogSetupError
  | CostSetupError
  | CreditAccessError
  | IdleFindingAccessError
  | NetworkFlowSetupError
  | OAuthTokenError
  | QuotaAccessError
  | VulnerabilityAccessError;

/** What every asynchronous operation of the plugin contract returns. */
export type PluginEffect<A> = Effect.Effect<A, PluginFailure>;

/** What a streaming operation of the plugin contract returns. */
export type PluginStream<A> = Stream.Stream<A, PluginFailure>;

/**
 * What a host sees in place of a contract return type. Distributes over unions,
 * which is what keeps `renderPeerPane` (sync or effectful) honest.
 */
export type Hosted<R> =
  R extends Effect.Effect<infer A, infer _E, infer _R>
    ? Promise<A>
    : R extends Stream.Stream<infer A, infer _E, infer _R>
      ? AsyncIterable<A>
      : R;

/** `T` with every contract method swapped for its host-facing signature. */
export type HostedMethods<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer P) => infer R
    ? (...args: P) => Hosted<R>
    : T[K];
};

/**
 * A plugin client as a host holds it: methods run on call and return Promises.
 * Hosts only ever get one of these, from `plugin-loader`, so `await
 * client.deleteResource?.(...)` cannot quietly await an Effect that never ran.
 */
export type HostPluginClient = HostedMethods<PluginClient>;

/** A plugin as a host holds it. See {@link HostPluginClient}. */
export type HostPlugin = Omit<HostedMethods<Plugin>, "createClient"> & {
  createClient(credentials: Record<string, string>, services?: HostServices): HostPluginClient;
};
