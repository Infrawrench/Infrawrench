import { z } from "zod";
import type { TerraformValue } from "../terraform.js";

const terraformValueSchema: z.ZodType<TerraformValue> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("string"), value: z.string() }),
    z.object({ kind: z.literal("number"), value: z.number() }),
    z.object({ kind: z.literal("bool"), value: z.boolean() }),
    z.object({ kind: z.literal("ref"), expr: z.string().min(1) }),
    z.object({ kind: z.literal("list"), items: z.array(terraformValueSchema) }),
    z.object({ kind: z.literal("map"), entries: z.record(terraformValueSchema) }),
    z.object({ kind: z.literal("block"), attributes: z.record(terraformValueSchema) }),
  ]),
);

/**
 * Validates the declarative half of a plugin's `terraformExport` capability.
 * `mapResource` is a function, so it is only checked for callability.
 */
export const terraformExportCapabilitySchema = z.object({
  provider: z.object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, "provider name must be a lowercase identifier"),
    source: z
      .string()
      .min(1)
      .regex(/^[\w.-]+\/[\w.-]+$/, "source must be a registry address like namespace/name"),
    version: z.string().min(1),
  }),
  providerConfig: z.record(terraformValueSchema),
  variables: z.array(
    z.object({
      name: z
        .string()
        .min(1)
        .regex(/^[a-z_][a-z0-9_]*$/, "variable name must be a lowercase identifier"),
      description: z.string().optional(),
      sensitive: z.boolean().optional(),
    }),
  ),
  supportedResourceTypeIds: z.array(z.string().min(1)).min(1),
  mapResource: z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function", {
    message: "mapResource must be a function",
  }),
});
