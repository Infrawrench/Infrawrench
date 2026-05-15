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
});
