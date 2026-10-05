import { z } from "zod";

import { FOCUS_SERVICE_CATEGORIES, isValidFocusClassification } from "../focus.js";
import { findUnsafeSvgConstructs } from "../svg-safety.js";

/**
 * `logoSvg` is injected verbatim with `dangerouslySetInnerHTML` by every host
 * surface, so the manifest is the trust boundary for that markup and this is
 * where the boundary is enforced. Both loaders (`server-core/plugin-loader.ts`
 * and the desktop `plugins/loader.ts`) parse the manifest through this schema
 * and skip the plugin when it fails, which means a logo that could execute
 * anything never reaches a renderer. See `../svg-safety.ts` for the rules and
 * `web/src/api/security-headers.ts` for why there is no script CSP behind it.
 */
function logoSvgIsInert(value: string, ctx: z.RefinementCtx): void {
  for (const problem of findUnsafeSvgConstructs(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `logoSvg is not inert: ${problem}` });
  }
}

const inertSvg = z.string().min(1).superRefine(logoSvgIsInert);

/**
 * A FOCUS category/subcategory pair. Both are closed lists in the
 * specification and the subcategory must be a child of the category, so a
 * typo here would otherwise ship as a non-conformant export.
 */
const focusClassificationShape = z.object({
  category: z.enum(FOCUS_SERVICE_CATEGORIES),
  subcategory: z.string(),
});
const FOCUS_PAIR_MESSAGE = "subcategory must be one of the FOCUS v1.3 children of category";
const focusClassification = focusClassificationShape.refine(isValidFocusClassification, {
  message: FOCUS_PAIR_MESSAGE,
});
const focusServiceRule = focusClassificationShape
  .extend({ match: z.string().min(1) })
  .refine(isValidFocusClassification, { message: FOCUS_PAIR_MESSAGE });

export const pluginManifestSchema = z.object({
  sshInstall: z
    .object({ description: z.string().min(1), messages: z.array(z.string()).optional() })
    .optional(),
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver"),
  displayName: z.string().min(1),
  description: z.string().optional(),
  logoSvg: inertSvg,
  author: z.string().min(1),
  minHostVersion: z.string().regex(/^\d+\.\d+\.\d+/),
  peerPlugins: z.array(z.string()).optional(),
  credentialFields: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        description: z.string().optional(),
        sensitive: z.boolean(),
        placeholder: z.string().optional(),
        multiline: z.boolean().optional(),
        defaultValue: z.string().optional(),
        regions: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              location: z.string().optional(),
              flag: z.string().optional(),
            }),
          )
          .optional(),
        accountReference: z
          .object({
            pluginId: z.string().min(1),
          })
          .optional(),
        providerOptions: z
          .object({
            dependsOn: z.array(z.string().min(1)),
            emptyLabel: z.string().optional(),
          })
          .optional(),
        optional: z.boolean().optional(),
      }),
    )
    .optional(),
  sqlDriver: z
    .object({
      driver: z.string().min(1),
      credentialKey: z.string().min(1),
    })
    .optional(),
  kvDriver: z
    .object({
      driver: z.string().min(1),
      credentialKey: z.string().min(1),
    })
    .optional(),
  dockerDriver: z
    .object({
      driver: z.string().min(1),
      credentialKey: z.string().min(1),
    })
    .optional(),
  supportsSecretImport: z.boolean().optional(),
  rateLimit: z
    .object({
      capacity: z.number().positive(),
      refillPerSecond: z.number().positive(),
    })
    .optional(),
  costs: z
    .object({
      dimensions: z.array(z.enum(["service", "region", "resource", "tag"])),
      maxHistoryDays: z.number().int().positive().optional(),
      restatementDays: z.number().int().positive().optional(),
      periodNative: z.boolean().optional(),
      /** This provider distinguishes charge types (usage vs credit vs tax…). */
      chargeTypes: z.boolean().optional(),
      /** This provider reports amortized amounts distinct from cash amounts. */
      amortization: z.boolean().optional(),
      /** Amounts are derived (inventory × rate card, usage × list prices). */
      estimated: z.boolean().optional(),
      /** FOCUS service classification for FOCUS-schema exports. */
      focus: z
        .object({
          services: z.array(focusServiceRule).optional(),
          default: focusClassification.optional(),
        })
        .optional(),
    })
    .optional(),
  commitments: z
    .object({
      kinds: z.array(z.enum(["reservation", "savings_plan", "committed_use"])).min(1),
    })
    .optional(),
  credits: z
    .object({
      label: z.string().optional(),
      topUpUrl: z.string().url().optional(),
      requiresElevatedCredential: z.boolean().optional(),
    })
    .optional(),
  quotas: z
    .object({
      label: z.string().optional(),
      // `.url()` alone is not a scheme guard: it is `new URL()` in a
      // try/catch, so `javascript:alert(1)` and `data:text/html,…` both pass
      // it. This value is rendered as a link the host opens, so the scheme is
      // pinned here as well as at the two runtime boundaries.
      increaseUrl: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), {
          message: "increaseUrl must be an https:// URL",
        })
        .optional(),
      /** The reported set is representative, not every quota the provider enforces. */
      partial: z.boolean().optional(),
      requiresElevatedCredential: z.boolean().optional(),
    })
    .optional(),
  warehouseSink: z
    .object({
      label: z.string().min(1),
      description: z.string().optional(),
      targetFields: z
        .array(
          z.object({
            key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
            label: z.string().min(1),
            description: z.string().optional(),
            dependsOn: z.array(z.string()).optional(),
            optional: z.boolean().optional(),
            allowCustom: z.boolean().optional(),
            placeholder: z.string().optional(),
            emptyLabel: z.string().optional(),
          }),
        )
        .min(1),
    })
    .optional(),
  priceCatalog: z
    .object({
      requiresCredentials: z.boolean(),
      permission: z.string().min(1).optional(),
      source: z.object({
        name: z.string().min(1),
        // Rendered as a link on the catalog's coverage note, so the scheme is
        // pinned like `quotas.increaseUrl`.
        url: z
          .string()
          .url()
          .refine((u) => u.startsWith("https://"), {
            message: "priceCatalog.source.url must be an https:// URL",
          }),
      }),
      refreshHours: z
        .number()
        .positive()
        .max(24 * 31),
      regionScoped: z.boolean().optional(),
      services: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            family: z.enum(["compute", "gpu", "database", "kubernetes-node", "storage"]),
          }),
        )
        .min(1)
        .refine((list) => new Set(list.map((s) => s.id)).size === list.length, {
          message: "priceCatalog service ids must be unique",
        }),
      regions: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            area: z.enum([
              "north-america",
              "south-america",
              "europe",
              "asia-pacific",
              "middle-east",
              "africa",
              "oceania",
            ]),
          }),
        )
        .min(1)
        .refine((list) => new Set(list.map((r) => r.id)).size === list.length, {
          message: "priceCatalog region ids must be unique",
        }),
    })
    .optional(),
  statusFeed: z
    .object({
      url: z.string().url(),
      format: z.enum(["statuspage-v2", "custom-json", "rss", "atom"]),
      statusPageUrl: z.string().url().optional(),
    })
    .optional(),
  preflight: z
    .object({
      capabilities: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
            requiredPermissions: z.array(
              z.object({
                id: z.string().min(1),
                label: z.string().min(1),
              }),
            ),
            essential: z.boolean().optional(),
          }),
        )
        .min(1)
        .refine((caps) => new Set(caps.map((c) => c.id)).size === caps.length, {
          message: "capability ids must be unique within the plugin",
        }),
      templateFormat: z
        .object({
          label: z.string().min(1),
          language: z.enum(["json", "yaml", "text"]),
        })
        .optional(),
    })
    .optional(),
});
