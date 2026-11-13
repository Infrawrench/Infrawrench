import { Schema } from "effect";

import {
  FOCUS_SERVICE_CATEGORIES,
  isValidFocusClassification,
  type FocusServiceClassification,
} from "../focus.js";
import { CI_EXECUTOR_KINDS } from "../ci.js";
import { PRODUCT_IDS } from "../preflight.js";
import { findUnsafeSvgConstructs } from "../svg-safety.js";
import {
  NonEmpty,
  NonNegative,
  Num,
  Positive,
  PositiveInt,
  Url,
  httpsUrl,
  uniqueBy,
  rule,
} from "./primitives.js";

/**
 * `logoSvg` is injected verbatim with `dangerouslySetInnerHTML` by every host
 * surface, so the manifest is the trust boundary for that markup and this is
 * where the boundary is enforced. Both loaders (`server-core/plugin-loader.ts`
 * and the desktop `plugins/loader.ts`) parse the manifest through this schema
 * and skip the plugin when it fails, which means a logo that could execute
 * anything never reaches a renderer. See `../svg-safety.ts` for the rules and
 * `web/src/api/security-headers.ts` for why there is no script CSP behind it.
 */
const inertSvg = NonEmpty.check(
  Schema.makeFilter((value: string) =>
    findUnsafeSvgConstructs(value).map((problem) => `logoSvg is not inert: ${problem}`),
  ),
);

/**
 * A FOCUS category/subcategory pair. Both are closed lists in the
 * specification and the subcategory must be a child of the category, so a
 * typo here would otherwise ship as a non-conformant export.
 */
const focusClassificationFields = {
  category: Schema.Literals(FOCUS_SERVICE_CATEGORIES),
  subcategory: Schema.String,
};
const FOCUS_PAIR_MESSAGE = "subcategory must be one of the FOCUS v1.3 children of category";
const focusClassification = Schema.Struct(focusClassificationFields).pipe(
  Schema.refine(isValidFocusClassification, { message: FOCUS_PAIR_MESSAGE }),
);
const focusServiceRule = Schema.Struct({
  ...focusClassificationFields,
  match: NonEmpty,
}).pipe(
  Schema.refine((c): c is typeof c & FocusServiceClassification => isValidFocusClassification(c), {
    message: FOCUS_PAIR_MESSAGE,
  }),
);

const driverFields = { driver: NonEmpty, credentialKey: NonEmpty };

const networkFlowScopes = Schema.Literals([
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "internet_ingress",
  "provider_service",
  "nat_gateway",
  "private_interconnect",
  "unknown",
]);
const perScopeRate = Schema.Record(networkFlowScopes, Schema.optional(Num));
const networkFlowRateCard = Schema.Struct({
  currency: Schema.String,
  asOf: Schema.String,
  perGb: perScopeRate,
  perRegion: Schema.optional(Schema.Record(Schema.String, perScopeRate)),
});

export const pluginManifestSchema = Schema.Struct({
  sshInstall: Schema.optional(
    Schema.Struct({
      description: NonEmpty,
      messages: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  id: NonEmpty.check(
    Schema.isPattern(/^[a-z][a-z0-9-]*$/, { message: "id must be lowercase kebab-case" }),
  ),
  displayName: NonEmpty,
  description: Schema.optional(Schema.String),
  logoSvg: inertSvg,
  egressHosts: Schema.Array(Schema.String),
  sshTunnel: Schema.optional(
    Schema.Struct({
      label: Schema.String,
      defaultPort: Num,
      credentials: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  jumpHost: Schema.optional(Schema.Boolean),
  peerPlugins: Schema.optional(Schema.Array(Schema.String)),
  credentialFields: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      description: Schema.optional(Schema.String),
      sensitive: Schema.Boolean,
      placeholder: Schema.optional(Schema.String),
      multiline: Schema.optional(Schema.Boolean),
      defaultValue: Schema.optional(Schema.String),
      regions: Schema.optional(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            label: Schema.String,
            location: Schema.optional(Schema.String),
            flag: Schema.optional(Schema.String),
          }),
        ),
      ),
      accountReference: Schema.optional(Schema.Struct({ pluginId: NonEmpty })),
      providerOptions: Schema.optional(
        Schema.Struct({
          dependsOn: Schema.Array(NonEmpty),
          emptyLabel: Schema.optional(Schema.String),
          multiple: Schema.optional(Schema.Boolean),
        }),
      ),
      optional: Schema.optional(Schema.Boolean),
      advanced: Schema.optional(Schema.Boolean),
      helpLink: Schema.optional(Schema.Struct({ label: Schema.String, url: Schema.String })),
      providerHost: Schema.optional(Schema.Boolean),
      providerHostSubdomains: Schema.optional(Schema.Boolean),
    }),
  ),
  oauth: Schema.optional(
    Schema.Struct({
      authorizeUrl: Schema.String,
      tokenUrl: Schema.String,
      scopes: Schema.Array(Schema.String),
      scopeSeparator: Schema.optional(Schema.String),
      authorizeParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      tokenField: Schema.String,
      clients: Schema.Struct({
        server: Schema.optional(
          Schema.Struct({
            auth: Schema.optional(
              Schema.Literals(["client_secret_post", "client_secret_basic", "none"]),
            ),
            pkce: Schema.optional(Schema.Boolean),
          }),
        ),
        desktop: Schema.optional(
          Schema.Struct({
            loopbackHost: Schema.optional(Schema.Literals(["127.0.0.1", "localhost"])),
          }),
        ),
      }),
      access: Schema.Literals(["read-only", "read-write", "full"]),
      refresh: Schema.Literals(["rotating", "reusable", "none"]),
      docsUrl: Schema.optional(Schema.String),
      clientRegistration: Schema.optional(Schema.Literals(["static", "none", "dynamic"])),
      defaultExpiresIn: Schema.optional(Num),
      existingGrantsOnly: Schema.optional(Schema.Boolean),
    }),
  ),
  sqlDriver: Schema.optional(
    Schema.Struct({ ...driverFields, caCertKey: Schema.optional(Schema.String) }),
  ),
  kvDriver: Schema.optional(
    Schema.Struct({
      ...driverFields,
      browser: Schema.optional(Schema.Literals(["keys", "documents"])),
    }),
  ),
  dockerDriver: Schema.optional(Schema.Struct(driverFields)),
  kubernetesDriver: Schema.optional(Schema.Struct(driverFields)),
  supportsSecretImport: Schema.optional(Schema.Boolean),
  rateLimit: Schema.optional(
    Schema.Struct({
      capacity: Positive,
      refillPerSecond: Positive,
    }),
  ),
  costs: Schema.optional(
    Schema.Struct({
      dimensions: Schema.Array(Schema.Literals(["service", "region", "resource", "tag"])),
      maxHistoryDays: Schema.optional(PositiveInt),
      restatementDays: Schema.optional(PositiveInt),
      periodNative: Schema.optional(Schema.Boolean),
      /** This provider distinguishes charge types (usage vs credit vs tax…). */
      chargeTypes: Schema.optional(Schema.Boolean),
      /** This provider reports amortized amounts distinct from cash amounts. */
      amortization: Schema.optional(Schema.Boolean),
      blending: Schema.optional(Schema.Boolean),
      /** Amounts are derived (inventory × rate card, usage × list prices). */
      estimated: Schema.optional(Schema.Boolean),
      /** FOCUS service classification for FOCUS-schema exports. */
      focus: Schema.optional(
        Schema.Struct({
          services: Schema.optional(Schema.Array(focusServiceRule)),
          default: Schema.optional(focusClassification),
        }),
      ),
    }),
  ),
  aiRequestLogs: Schema.optional(
    Schema.Struct({
      sourceKinds: Schema.Array(
        Schema.Struct({
          id: NonEmpty,
          label: NonEmpty,
          description: Schema.String,
          locationLabel: NonEmpty,
          maxHistoryDays: PositiveInt,
          queriesBillable: Schema.optional(Schema.Boolean),
          acceptsPrefix: Schema.optional(Schema.Boolean),
          helpUrl: Schema.optional(httpsUrl("helpUrl must be https://")),
        }),
      ).check(Schema.isMinLength(1)),
    }),
  ),
  aiModelRates: Schema.optional(
    Schema.Struct({
      provider: NonEmpty,
      currency: NonEmpty,
      asOf: NonEmpty,
      models: Schema.Record(
        Schema.String,
        Schema.Struct({
          input: NonNegative,
          output: NonNegative,
          cacheRead: Schema.optional(NonNegative),
          cacheWrite: Schema.optional(NonNegative),
          reasoning: Schema.optional(NonNegative),
        }),
      ),
    }),
  ),
  businessMetricSource: Schema.optional(
    Schema.Struct({
      label: Schema.String,
      description: Schema.optional(Schema.String),
      kind: Schema.Literals(["sql", "metric"]),
      fields: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          label: Schema.String,
          type: Schema.Literals(["select", "sql", "text", "number"]),
          required: Schema.optional(Schema.Boolean),
          description: Schema.optional(Schema.String),
          placeholder: Schema.optional(Schema.String),
          defaultValue: Schema.optional(Schema.String),
          options: Schema.optional(
            Schema.Array(
              Schema.Struct({
                id: Schema.String,
                label: Schema.String,
                description: Schema.optional(Schema.String),
              }),
            ),
          ),
          dependsOn: Schema.optional(Schema.Array(Schema.String)),
          allowCustom: Schema.optional(Schema.Boolean),
        }),
      ),
      sqlDialect: Schema.optional(Schema.String),
      readOnly: Schema.optional(Schema.Literals(["enforced", "validated"])),
      supportsDryRun: Schema.optional(Schema.Boolean),
    }),
  ),
  networkFlows: Schema.optional(
    Schema.Struct({
      rates: networkFlowRateCard,
      maxPairsPerDay: Num,
      maxHistoryDays: Num,
      queriesBillable: Schema.optional(Schema.Boolean),
      sampled: Schema.optional(Schema.Boolean),
      recut: Schema.optional(Schema.Boolean),
    }),
  ),
  transferRates: Schema.optional(networkFlowRateCard),
  commitments: Schema.optional(
    Schema.Struct({
      kinds: Schema.Array(Schema.Literals(["reservation", "savings_plan", "committed_use"])).check(
        Schema.isMinLength(1),
      ),
      discount: Schema.optional(
        Schema.Struct({
          min: Schema.optional(Num),
          max: Num,
          basis: Schema.Literals(["range", "upper_bound"]),
        }),
      ),
    }),
  ),
  seats: Schema.optional(
    Schema.Struct({
      products: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
      removal: Schema.optional(Schema.Boolean),
    }),
  ),
  credits: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      topUpUrl: Schema.optional(Url),
      requiresElevatedCredential: Schema.optional(Schema.Boolean),
    }),
  ),
  quotas: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      increaseUrl: Schema.optional(httpsUrl("increaseUrl must be an https:// URL")),
      /** The reported set is representative, not every quota the provider enforces. */
      partial: Schema.optional(Schema.Boolean),
      requiresElevatedCredential: Schema.optional(Schema.Boolean),
    }),
  ),
  idleFindings: Schema.optional(
    Schema.Struct({
      rules: Schema.Array(
        Schema.Struct({
          id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
          label: NonEmpty,
          description: NonEmpty,
          resourceTypeIds: Schema.Array(NonEmpty),
          action: Schema.Literals(["remove", "reconfigure", "stop"]),
          thresholds: Schema.Array(
            Schema.Struct({
              key: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]{0,63}$/)),
              label: NonEmpty,
              description: Schema.optional(Schema.String),
              unit: Schema.Literals(["count", "bytes", "percent", "days"]),
              default: Schema.Finite,
              min: Schema.Finite,
              max: Schema.Finite,
            }).check(
              rule(
                (t) => t.min <= t.default && t.default <= t.max,
                "idle threshold default must sit within [min, max]",
              ),
            ),
          ).check(uniqueBy((t) => t.key, "idle threshold keys must be unique within a rule")),
        }),
      ).check(
        Schema.isMinLength(1),
        uniqueBy((r) => r.id, "idle rule ids must be unique"),
      ),
    }),
  ),
  vulnerabilities: Schema.optional(
    Schema.Struct({
      label: NonEmpty,
      consoleUrl: Schema.optional(httpsUrl("consoleUrl must be an https:// URL")),
      requiresElevatedCredential: Schema.optional(Schema.Boolean),
      partial: Schema.optional(Schema.Boolean),
    }),
  ),
  warehouseSink: Schema.optional(
    Schema.Struct({
      label: NonEmpty,
      description: Schema.optional(Schema.String),
      targetFields: Schema.Array(
        Schema.Struct({
          key: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)),
          label: NonEmpty,
          description: Schema.optional(Schema.String),
          dependsOn: Schema.optional(Schema.Array(Schema.String)),
          optional: Schema.optional(Schema.Boolean),
          allowCustom: Schema.optional(Schema.Boolean),
          placeholder: Schema.optional(Schema.String),
          emptyLabel: Schema.optional(Schema.String),
        }),
      ).check(Schema.isMinLength(1)),
    }),
  ),
  priceCatalog: Schema.optional(
    Schema.Struct({
      requiresCredentials: Schema.Boolean,
      permission: Schema.optional(NonEmpty),
      source: Schema.Struct({
        name: NonEmpty,
        url: httpsUrl("priceCatalog.source.url must be an https:// URL"),
      }),
      refreshHours: Positive.check(Schema.isLessThanOrEqualTo(24 * 31)),
      regionScoped: Schema.optional(Schema.Boolean),
      services: Schema.Array(
        Schema.Struct({
          id: NonEmpty,
          label: NonEmpty,
          family: Schema.Literals(["compute", "gpu", "database", "kubernetes-node", "storage"]),
        }),
      ).check(
        Schema.isMinLength(1),
        uniqueBy((s) => s.id, "priceCatalog service ids must be unique"),
      ),
      regions: Schema.Array(
        Schema.Struct({
          id: NonEmpty,
          label: NonEmpty,
          area: Schema.Literals([
            "north-america",
            "south-america",
            "europe",
            "asia-pacific",
            "middle-east",
            "africa",
            "oceania",
          ]),
        }),
      ).check(
        Schema.isMinLength(1),
        uniqueBy((r) => r.id, "priceCatalog region ids must be unique"),
      ),
    }),
  ),
  paging: Schema.optional(
    Schema.Struct({
      targetLabel: NonEmpty,
      targetDescription: Schema.optional(Schema.String),
      supportsAcknowledgeEvent: Schema.Boolean,
      onCall: Schema.optional(Schema.Struct({ sourceLabel: NonEmpty })),
      incidents: Schema.optional(
        Schema.Struct({
          label: NonEmpty,
          canAcknowledge: Schema.Boolean,
          canResolve: Schema.Boolean,
        }),
      ),
      webhook: Schema.optional(
        Schema.Struct({
          mode: Schema.Literals(["managed", "manual"]),
          setupHelp: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  jitAccess: Schema.optional(
    Schema.Struct({
      scopeLabel: NonEmpty,
      roleLabel: NonEmpty,
      principalLabel: NonEmpty,
      description: Schema.optional(Schema.String),
      providerEnforcedExpiry: Schema.Boolean,
      principalPicker: Schema.Boolean,
    }),
  ),
  secretScanning: Schema.optional(
    Schema.Struct({
      label: NonEmpty,
      description: Schema.optional(Schema.String),
      canResolve: Schema.Boolean,
      returnsSecretValue: Schema.Boolean,
    }),
  ),
  ciExecutor: Schema.optional(
    Schema.Struct({
      kinds: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(CI_EXECUTOR_KINDS),
          label: NonEmpty,
          defaults: Schema.Struct({
            machine: Schema.optional(NonEmpty),
            image: Schema.optional(NonEmpty),
            region: Schema.optional(NonEmpty),
          }),
          typicalStartSeconds: Schema.optional(PositiveInt),
          minimumBillingSeconds: Schema.optional(PositiveInt),
          gpus: Schema.optional(Schema.Boolean),
          machineSuggestions: Schema.optional(Schema.Array(NonEmpty)),
        }),
      ).check(Schema.isMinLength(1)),
      helpLink: Schema.optional(Schema.Struct({ label: NonEmpty, url: Url })),
    }),
  ),
  ciCredential: Schema.optional(
    Schema.Struct({
      description: NonEmpty,
      shortLived: Schema.Boolean,
      namespaces: Schema.optional(Schema.Boolean),
    }),
  ),
  tokenFormats: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: NonEmpty,
        label: NonEmpty,
        scannerTypes: Schema.Array(NonEmpty),
        prefixes: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(4)))),
        credentialFields: Schema.optional(Schema.Array(NonEmpty)),
        manageUrl: Schema.optional(Url),
      }),
    ),
  ),
  statusFeed: Schema.optional(
    Schema.Struct({
      url: Url,
      format: Schema.Literals(["statuspage-v2", "custom-json", "rss", "atom"]),
      statusPageUrl: Schema.optional(Url),
      reachableFromEdge: Schema.optional(Schema.Boolean),
    }),
  ),
  preflight: Schema.optional(
    Schema.Struct({
      capabilities: Schema.Array(
        Schema.Struct({
          id: NonEmpty,
          product: Schema.optional(Schema.Literals(PRODUCT_IDS)),
          label: NonEmpty,
          description: Schema.optional(Schema.String),
          requiredPermissions: Schema.Array(
            Schema.Struct({
              id: NonEmpty,
              label: NonEmpty,
            }),
          ),
          essential: Schema.optional(Schema.Boolean),
        }),
      ).check(
        Schema.isMinLength(1),
        uniqueBy((c) => c.id, "capability ids must be unique within the plugin"),
      ),
      templateFormat: Schema.optional(
        Schema.Struct({
          label: NonEmpty,
          language: Schema.Literals(["json", "yaml", "text"]),
        }),
      ),
    }),
  ),
});
