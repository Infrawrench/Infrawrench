import { z } from "zod";

export const pluginManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver"),
  displayName: z.string().min(1),
  description: z.string().optional(),
  logoSvg: z.string().min(1),
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
