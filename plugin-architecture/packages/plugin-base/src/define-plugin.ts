/**
 * `definePlugin`: the one place the plugin contract's "if you declare X you must
 * implement Y" rules live.
 *
 * {@link MANIFEST_REQUIREMENTS} is the source of truth for all of them. The same
 * rows drive the compile-time check here, the loaders' registration check
 * (`validatePluginContract`), and the conformance tests in `test-harness.ts`, so
 * adding a capability means adding one row.
 */
import type {
  CredentialField,
  HostServices,
  Plugin,
  PluginClient,
  PluginManifest,
} from "./manifest.js";
import type { OAUTH_CREDENTIAL_KEY } from "./oauth.js";
import type { ResourceTypeDefinition } from "./resource.js";

/**
 * Declaring the manifest path (every segment truthy) obliges the plugin to
 * implement `client` methods and `plugin` hooks. Paths ending in a flag are only
 * enforced at compile time when the flag is a literal `true`, which is what a
 * manifest written inline gives; the conformance tests cover the rest.
 */
export const MANIFEST_REQUIREMENTS = [
  { when: ["costs"], client: ["fetchCostData"] },
  { when: ["commitments"], client: ["fetchCommitments"] },
  { when: ["credits"], client: ["fetchCreditBalance"] },
  { when: ["seats"], client: ["fetchSeats"] },
  { when: ["quotas"], client: ["fetchQuotas"] },
  { when: ["idleFindings"], client: ["fetchIdleFindings"] },
  { when: ["vulnerabilities"], client: ["listVulnerabilityFindings"] },
  { when: ["networkFlows"], client: ["fetchNetworkFlows"] },
  { when: ["aiRequestLogs"], client: ["fetchAiRequestLogs", "listAiRequestLogLocations"] },
  { when: ["businessMetricSource"], client: ["runBusinessMetricSource"] },
  { when: ["businessMetricSource", "supportsDryRun"], client: ["dryRunBusinessMetricSource"] },
  { when: ["warehouseSink"], client: ["loadWarehouseRows", "describeWarehouseSetup"] },
  { when: ["statusFeed"], plugin: ["parseStatusFeed"] },
  { when: ["sshInstall"], client: ["installOnSsh"] },
  { when: ["supportsSecretImport"], client: ["importSecret"] },
  { when: ["preflight"], client: ["verifyCredentials"] },
  { when: ["preflight", "templateFormat"], plugin: ["policyTemplate"] },
  { when: ["paging"], client: ["listPagingTargets", "sendPagingEvent"] },
  { when: ["paging", "onCall"], client: ["listPagingOnCallSources", "resolvePagingOnCall"] },
  {
    when: ["paging", "incidents"],
    client: ["listPagingIncidents", "getPagingIncident", "updatePagingIncident"],
  },
  { when: ["paging", "webhook"], plugin: ["verifyPagingWebhook"] },
  {
    when: ["jitAccess"],
    client: [
      "listJitScopes",
      "listJitRoles",
      "resolveJitPrincipal",
      "grantJitAccess",
      "revokeJitAccess",
      "checkJitAccess",
    ],
  },
  { when: ["jitAccess", "principalPicker"], client: ["listJitPrincipals"] },
  { when: ["secretScanning"], client: ["listLeakedSecrets"] },
  { when: ["secretScanning", "canResolve"], client: ["resolveLeakedSecret"] },
  {
    when: ["ciExecutor"],
    client: ["ciPreflight", "ciStart", "ciStatus", "ciTeardown", "ciListTagged"],
  },
  { when: ["ciCredential"], client: ["lendCiCredential"] },
] as const satisfies readonly {
  when: readonly string[];
  client?: readonly (keyof PluginClient)[];
  plugin?: readonly (keyof Plugin)[];
}[];

/**
 * Resource type flags and the client methods they oblige. A resource type is
 * usually declared in a file of its own and typed with the wide definition, so
 * these are enforced by the conformance tests rather than the compiler.
 */
export const RESOURCE_TYPE_REQUIREMENTS = {
  supportsCreate: ["createResource", "getCreateConfig"],
  supportsDelete: ["deleteResource"],
  supportsUpdate: ["updateResource"],
  supportsMetrics: ["fetchMetricSeries"],
  supportsTerminal: ["getSshConfig"],
  supportsStorageBrowser: ["listStorageObjects"],
} as const satisfies Partial<Record<keyof ResourceTypeDefinition, readonly (keyof PluginClient)[]>>;

/**
 * Requirements that hang on a value rather than on presence, so they cannot be a
 * row: which half of the price catalog runs depends on `requiresCredentials`.
 */
function conditionalProblems(plugin: ContractSubject): string[] {
  const problems: string[] = [];
  const { priceCatalog } = plugin.manifest;
  if (priceCatalog && !priceCatalog.requiresCredentials) {
    if (typeof plugin.fetchPriceCatalog !== "function") {
      problems.push("manifest.priceCatalog is public but the plugin has no fetchPriceCatalog()");
    }
  }
  return problems;
}

type ContractSubject = Pick<Plugin, "manifest"> & Partial<Plugin>;

function isDeclared(manifest: PluginManifest, path: readonly string[]): boolean {
  let current: unknown = manifest;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return false;
    current = Reflect.get(current, segment);
    if (!current) return false;
  }
  return true;
}

/**
 * Registration-time check of everything knowable without a client: the
 * plugin-level half of the requirements. Returns one description per problem;
 * loaders reject a plugin that has any.
 */
export function validatePluginContract(plugin: ContractSubject): string[] {
  const problems = conditionalProblems(plugin);
  for (const row of MANIFEST_REQUIREMENTS) {
    if (!("plugin" in row) || !isDeclared(plugin.manifest, row.when)) continue;
    for (const hook of row.plugin) {
      if (typeof plugin[hook] !== "function") {
        problems.push(`manifest.${row.when.join(".")} is declared but the plugin has no ${hook}()`);
      }
    }
  }
  return problems;
}

/**
 * The client half of the requirements, for code that has a client in hand: the
 * conformance tests. Works on host and contract clients alike, because it only
 * looks at which methods exist.
 */
export function clientContractProblems(
  plugin: Pick<Plugin, "manifest" | "resourceTypes">,
  client: object,
): string[] {
  const has = (method: string) => typeof Reflect.get(client, method) === "function";
  const problems: string[] = [];
  for (const row of MANIFEST_REQUIREMENTS) {
    if (!("client" in row) || !isDeclared(plugin.manifest, row.when)) continue;
    for (const method of row.client) {
      if (!has(method)) {
        problems.push(
          `manifest.${row.when.join(".")} is declared but the client has no ${method}()`,
        );
      }
    }
  }
  const { priceCatalog, paging } = plugin.manifest;
  if (priceCatalog?.requiresCredentials && !has("fetchPriceCatalog")) {
    problems.push(
      "manifest.priceCatalog needs credentials but the client has no fetchPriceCatalog()",
    );
  }
  if (paging?.webhook?.mode === "managed") {
    for (const method of ["registerPagingWebhook", "removePagingWebhook"]) {
      if (!has(method)) {
        problems.push(`manifest.paging.webhook is managed but the client has no ${method}()`);
      }
    }
  }
  for (const type of plugin.resourceTypes) {
    for (const [flag, methods] of Object.entries(RESOURCE_TYPE_REQUIREMENTS)) {
      if (!Reflect.get(type, flag)) continue;
      for (const method of methods) {
        if (!has(method))
          problems.push(`${type.id}.${flag} is set but the client has no ${method}()`);
      }
    }
  }
  return problems;
}

type Row = (typeof MANIFEST_REQUIREMENTS)[number];

/**
 * Whether `T` certainly declares `Path`. A segment the types only know as
 * optional, or a flag only known as `boolean`, might not be set, so it does not
 * count: a declaration built elsewhere and typed widely is left to the
 * conformance tests rather than rejected here.
 */
type Declares<T, Path extends readonly string[]> = Path extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? Head extends keyof T
    ? undefined extends T[Head]
      ? false
      : T[Head] extends boolean
        ? T[Head] extends true
          ? Rest extends readonly []
            ? true
            : false
          : false
        : Rest extends readonly []
          ? true
          : Declares<T[Head], Rest>
    : false
  : false;

type Names<R, Key extends "client" | "plugin"> = R extends {
  readonly [K in Key]: readonly (infer N)[];
}
  ? N
  : never;

/** The names `M` obliges a plugin to implement, on the client or on the plugin. */
type RequiredBy<M, Key extends "client" | "plugin", R extends Row = Row> = R extends Row
  ? Declares<M, R["when"]> extends true
    ? Names<R, Key>
    : never
  : never;

/**
 * The client a manifest obliges `createClient` to return. Declaring `costs` with
 * no `fetchCostData` on the class is a compile error at the `definePlugin` call.
 */
export type ClientFor<M> = PluginClient &
  Required<Pick<PluginClient, Extract<RequiredBy<M, "client">, keyof PluginClient>>>;

type HooksFor<M> = Required<Pick<Plugin, Extract<RequiredBy<M, "plugin">, keyof Plugin>>>;

type Fields<M> = M extends { readonly credentialFields: readonly (infer F)[] } ? F : never;

type FieldKey<F> = F extends { readonly key: infer K extends string } ? K : never;

/**
 * The credentials a manifest declares, every key optional because that is the
 * truth at runtime: a host can hand over an incomplete set (the credential forms
 * probe as you type), so a constructor keeps its "missing apiToken" check. What
 * this adds is that reading a key the manifest never declared stops compiling.
 *
 * Keys come from {@link defineCredentials}. `Undeclared` names keys a plugin
 * reads that have no form field, such as values written by `credentialUpdates`.
 * OAuth grant state is on every plugin's list, because the host owns it.
 */
export type CredentialsOf<M, Undeclared extends string = never> = {
  readonly [K in FieldKey<Fields<M>> | Undeclared | typeof OAUTH_CREDENTIAL_KEY]?: string;
};

/** The manifest's non-optional credentials, which test data must supply. */
type RequiredCredentialsOf<M> = {
  readonly [K in FieldKey<Exclude<Fields<M>, { readonly optional: true }>>]: string;
};

/** Keeps a credential list's keys literal so {@link CredentialsOf} can see them. */
export function defineCredentials<const T extends readonly CredentialField[]>(fields: T): T {
  return fields;
}

/** Keeps one reusable field's key literal. See {@link defineCredentials}. */
export function defineCredential<const T extends CredentialField>(field: T): T {
  return field;
}

/** A plugin definition: {@link Plugin} with its obligations worked out from `M`. */
export type PluginDefinition<M extends PluginManifest> = Omit<
  Plugin,
  "manifest" | "createClient" | "testCredentials"
> &
  HooksFor<M> & {
    manifest: M;
    createClient(credentials: CredentialsOf<M>, services?: HostServices): ClientFor<M>;
    testCredentials: RequiredCredentialsOf<M> & Readonly<Record<string, string>>;
  };

/**
 * Declare a plugin. Write the manifest as `const manifest = { ... } satisfies
 * PluginManifest` (annotating it `: PluginManifest` erases what this checks).
 */
export function definePlugin<M extends PluginManifest>(definition: PluginDefinition<M>): Plugin {
  // Hosts hold credentials as an opaque record, and the plugin validates them at
  // runtime either way. This is the one place the typed view meets that record.
  return definition as unknown as Plugin;
}

/** Every driver a plugin contributes, keeping the literal shape for its callers. */
export function defineNodeDrivers<const T>(drivers: T): T {
  return drivers;
}
