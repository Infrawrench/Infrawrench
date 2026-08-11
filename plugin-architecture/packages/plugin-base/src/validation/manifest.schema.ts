import { z } from "zod";

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

export const pluginManifestSchema = z.object({
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
