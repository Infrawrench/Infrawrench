/**
 * The runtime half of the Effect contract (`@infrawrench/plugin-base/effect`).
 *
 * Plugins build their operations with {@link attempt} and {@link attemptStream}.
 * Hosts never see any of it: their loader passes every plugin through
 * {@link hostPlugins}, after which a contract method runs when called and hands
 * back a Promise or an AsyncIterable, throwing exactly what the plugin threw.
 *
 * Running on call rather than on `await` is what keeps call-scoped host context
 * working. `withEgressScope` wraps each client method in an AsyncLocalStorage
 * scope that ends when the method returns, so a lazy Effect escaping it would
 * make its requests with the SSRF guard already gone.
 */
import { Cause, Data, Effect, Exit, Predicate, Stream } from "effect";
import type { AssociationRole, AssociationSource, CreateResourceConfig } from "./create.js";
import type {
  Hosted,
  HostedMethods,
  HostPlugin,
  HostPluginClient,
  PluginEffect,
  PluginFailure,
  PluginStream,
} from "./contract-effect.js";
import type { Plugin, PluginClient } from "./manifest.js";
import type {
  DockerNodeDriver,
  K8sNodeDriver,
  KvNodeDriver,
  PluginNodeDrivers,
  SqlNodeDriver,
  StorageNodeDriver,
} from "./node-driver.js";

/**
 * A plugin operation failed for a reason no typed failure describes. `cause` is
 * whatever was thrown, and it is what a host receives.
 *
 * `Data.TaggedError` rather than `Schema.TaggedError` on purpose: a failure
 * never crosses a serialization boundary here, and Schema would add ~80 KB
 * gzipped to everything that holds a client.
 */
export class PluginError extends Data.TaggedError("PluginError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const TYPED_FAILURE_TAGS: ReadonlySet<string> = new Set<PluginFailure["_tag"]>([
  "PluginError",
  "AiRequestLogSetupError",
  "CostSetupError",
  "CreditAccessError",
  "IdleFindingAccessError",
  "NetworkFlowSetupError",
  "OAuthTokenError",
  "QuotaAccessError",
  "VulnerabilityAccessError",
]);

function isPluginFailure(cause: unknown): cause is PluginFailure {
  return (
    Predicate.hasProperty(cause, "_tag") &&
    Predicate.isString(cause._tag) &&
    TYPED_FAILURE_TAGS.has(cause._tag)
  );
}

function toPluginFailure(cause: unknown): PluginFailure {
  if (isPluginFailure(cause)) return cause;
  return new PluginError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

/** A contract operation out of a Promise-returning body. */
export function attempt<A>(run: (signal: AbortSignal) => Promise<A>): PluginEffect<A> {
  return Effect.tryPromise({ try: run, catch: toPluginFailure });
}

/** A contract stream out of something that produces an async iterable. */
export function attemptStream<A>(open: () => AsyncIterable<A>): PluginStream<A> {
  return Stream.suspend(() => Stream.fromAsyncIterable(open(), toPluginFailure));
}

/** What a failure throws as: the original exception wherever there is one. */
function unwrapFailure(cause: Cause.Cause<PluginFailure>): unknown {
  const squashed = Cause.squash(cause);
  return squashed instanceof PluginError && squashed.cause !== undefined
    ? squashed.cause
    : squashed;
}

/**
 * Run a contract operation to a Promise, rethrowing what the plugin threw so
 * `instanceof` keeps working on the far side. Also takes a plain Promise: a test
 * double standing in for a contract method (`vi.spyOn(...).mockResolvedValue`)
 * returns one, and the plugin code calling it should not have to care.
 */
export async function runPluginEffect<A>(effect: PluginEffect<A> | Promise<A>): Promise<A> {
  if (!Effect.isEffect(effect)) return effect;
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw unwrapFailure(exit.cause);
}

/** A contract stream as an async iterable, for code outside Effect. */
export function runPluginStream<A>(stream: PluginStream<A>): AsyncIterable<A> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* Stream.toAsyncIterable(stream);
      } catch (error) {
        throw isPluginFailure(error) && error instanceof PluginError && error.cause !== undefined
          ? error.cause
          : error;
      }
    },
  };
}

/** Swap a contract return value for what a host should receive. */
function hostResult(result: unknown): unknown {
  if (Effect.isEffect(result)) return runPluginEffect(result as PluginEffect<unknown>);
  if (Stream.isStream(result)) return runPluginStream(result as PluginStream<unknown>);
  return result;
}

/**
 * Wrap an object's methods so they run on call. A Proxy rather than a copy: a
 * client is a class instance whose methods live on the prototype and may use
 * `#private` state, so they must keep executing against the original, and
 * optional methods must keep reading as `undefined` when absent.
 */
function hostedProxy<T extends object, R>(
  target: T,
  afterCall: (prop: string | symbol, result: unknown) => unknown,
): R {
  const wrappers = new Map<string | symbol, { source: unknown; wrapper: unknown }>();
  const proxy = new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (!Predicate.isFunction(value)) return value;
      const cached = wrappers.get(prop);
      if (cached && cached.source === value) return cached.wrapper;
      const wrapper = (...args: unknown[]) => afterCall(prop, Reflect.apply(value, obj, args));
      wrappers.set(prop, { source: value, wrapper });
      return wrapper;
    },
    set(obj, prop, value) {
      return Reflect.set(obj, prop, value, obj);
    },
  });
  // The one cast in the contract: a Proxy cannot express the mapped type it
  // implements, and `hostResult` is what makes it true.
  return proxy as unknown as R;
}

/** The host-facing view of a client. Plain `client` objects in tests pass through too. */
export function hostClient<C extends object = PluginClient>(client: C): HostedMethods<C> {
  return hostedProxy<C, HostedMethods<C>>(client, (_prop, result) => hostResult(result));
}

/** The host-facing view of a node driver. */
export const hostDriver = hostClient;

/** What one kind of host gets out of every plugin's `nodeDrivers`, keyed by id. */
export interface HostNodeDrivers {
  sqlDrivers: Map<string, HostedMethods<SqlNodeDriver>>;
  kvDrivers: Map<string, HostedMethods<KvNodeDriver>>;
  dockerDrivers: Map<string, HostedMethods<DockerNodeDriver>>;
  k8sDrivers: Map<string, HostedMethods<K8sNodeDriver>>;
  storageDrivers: Map<string, HostedMethods<StorageNodeDriver>>;
}

/** Index every plugin's drivers for one kind of host. */
export function collectNodeDrivers(
  plugins: readonly PluginNodeDrivers[],
  host: keyof PluginNodeDrivers,
): HostNodeDrivers {
  const out: HostNodeDrivers = {
    sqlDrivers: new Map(),
    kvDrivers: new Map(),
    dockerDrivers: new Map(),
    k8sDrivers: new Map(),
    storageDrivers: new Map(),
  };
  for (const plugin of plugins) {
    const { sql, kv, docker, k8s, storage } = plugin[host];
    if (sql) out.sqlDrivers.set(sql.id, hostDriver(sql));
    if (kv) out.kvDrivers.set(kv.id, hostDriver(kv));
    if (docker) out.dockerDrivers.set(docker.id, hostDriver(docker));
    if (k8s) out.k8sDrivers.set(k8s.id, hostDriver(k8s));
    if (storage) out.storageDrivers.set(storage.pluginId, hostDriver(storage));
  }
  return out;
}

/** Output-role catalog built from every loaded plugin's resource types. */
export type AssociationCatalog = ReadonlyMap<AssociationRole, readonly AssociationSource[]>;

/** Collect every output a resource type flags with `dnsValue`, by role. */
export function buildAssociationCatalog(plugins: readonly Plugin[]): AssociationCatalog {
  const catalog = new Map<AssociationRole, AssociationSource[]>();
  for (const plugin of plugins) {
    for (const type of plugin.resourceTypes) {
      for (const output of type.outputs) {
        if (!output.dnsValue) continue;
        const role: AssociationRole = `dns-${output.dnsValue}`;
        const entries = catalog.get(role) ?? [];
        entries.push({
          pluginId: plugin.manifest.id,
          resourceTypeId: type.id,
          outputKey: output.key,
        });
        catalog.set(role, entries);
      }
    }
  }
  return catalog;
}

/** Fill in `associationSources` for fields that named an `associationRole`. */
function resolveAssociationRoles(
  config: CreateResourceConfig,
  catalog: AssociationCatalog,
): CreateResourceConfig {
  if (!config.fields.some((field) => field.associationRole)) return config;
  return {
    ...config,
    fields: config.fields.map((field) => {
      const sources = field.associationRole ? catalog.get(field.associationRole) : undefined;
      return sources ? { ...field, associationSources: [...sources] } : field;
    }),
  };
}

/**
 * The host-facing view of a plugin. `createClient` hands back a
 * {@link HostPluginClient}; contract hooks on the plugin itself
 * (`fetchPriceCatalog`, the OAuth hooks) run on call like client methods do.
 */
export function hostPlugin(plugin: Plugin, catalog: AssociationCatalog = new Map()): HostPlugin {
  const afterClientCall = (prop: string | symbol, result: unknown): unknown => {
    const hosted = hostResult(result);
    if (prop !== "getCreateConfig" || !(hosted instanceof Promise)) return hosted;
    return hosted.then((config: CreateResourceConfig) => resolveAssociationRoles(config, catalog));
  };
  return hostedProxy<Plugin, HostPlugin>(plugin, (prop, result) =>
    prop === "createClient" && Predicate.isObject(result)
      ? hostedProxy<object, HostPluginClient>(result, afterClientCall)
      : hostResult(result),
  );
}

/** Every plugin's host-facing view, sharing one output-role catalog. */
export function hostPlugins(plugins: readonly Plugin[]): HostPlugin[] {
  const catalog = buildAssociationCatalog(plugins);
  return plugins.map((plugin) => hostPlugin(plugin, catalog));
}

export type { Hosted };

/** A contract hook out of an existing Promise-returning function. */
export function attemptFn<P extends readonly unknown[], A>(
  fn: (...args: P) => Promise<A>,
): (...args: P) => PluginEffect<A> {
  return (...args) => attempt(() => fn(...args));
}
