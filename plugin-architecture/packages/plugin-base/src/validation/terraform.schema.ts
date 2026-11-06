import { Predicate, Schema } from "effect";
import type { TerraformExportCapability, TerraformValue } from "../terraform.js";
import { NonEmpty, Num } from "./primitives.js";

const terraformValueSchema: Schema.Codec<TerraformValue> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("number"), value: Num }),
  Schema.Struct({ kind: Schema.Literal("bool"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("ref"), expr: NonEmpty }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    items: Schema.mutable(Schema.Array(Schema.suspend(() => terraformValueSchema))),
  }),
  Schema.Struct({
    kind: Schema.Literal("map"),
    entries: Schema.Record(
      Schema.String,
      Schema.suspend(() => terraformValueSchema),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("block"),
    attributes: Schema.Record(
      Schema.String,
      Schema.suspend(() => terraformValueSchema),
    ),
  }),
]).annotate({ expected: "a Terraform value (string, number, bool, ref, list, map or block)" });

/**
 * Validates the declarative half of a plugin's `terraformExport` capability.
 * `mapResource` is a function, so it is only checked for callability.
 */
export const terraformExportCapabilitySchema = Schema.Struct({
  provider: Schema.Struct({
    name: NonEmpty.check(
      Schema.isPattern(/^[a-z][a-z0-9-]*$/, {
        message: "provider name must be a lowercase identifier",
      }),
    ),
    source: NonEmpty.check(
      Schema.isPattern(/^[\w.-]+\/[\w.-]+$/, {
        message: "source must be a registry address like namespace/name",
      }),
    ),
    version: NonEmpty,
  }),
  providerConfig: Schema.Record(Schema.String, terraformValueSchema),
  variables: Schema.Array(
    Schema.Struct({
      name: NonEmpty.check(
        Schema.isPattern(/^[a-z_][a-z0-9_]*$/, {
          message: "variable name must be a lowercase identifier",
        }),
      ),
      description: Schema.optional(Schema.String),
      sensitive: Schema.optional(Schema.Boolean),
    }),
  ),
  supportedResourceTypeIds: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  mapResource: Schema.declare(
    (input): input is TerraformExportCapability["mapResource"] => Predicate.isFunction(input),
    { message: "mapResource must be a function" },
  ),
});
