import type { ResourceInstance } from "./instance.js";

/**
 * Terraform export capability — lets a plugin describe how its stored
 * resources map onto blocks for a well-known Terraform provider ("eject to
 * Terraform"). The capability is declared on the `Plugin` object (not the
 * client) because mapping works purely from a resource's stored inputs and
 * outputs: no credentials and no provider API calls are involved, so hosts
 * (web server, desktop CLI) can run it against persisted state.
 *
 * Plugins return *structured data* — never raw HCL strings. The host owns the
 * generic HCL serializer (`renderTerraformBundle` in `terraform-hcl.ts`), so
 * quoting, indentation, and name deduplication behave identically across all
 * providers. Secrets and credentials must be referenced as variables
 * (`{ kind: "ref", expr: "var.xyz" }` + a `TerraformVariable` declaration) —
 * a plugin must never inline a secret value into an attribute.
 */

/** A provider entry for the generated `terraform.required_providers` block. */
export interface TerraformProviderRequirement {
  /** Local provider name, e.g. "hcloud", "digitalocean", "cloudflare". */
  name: string;
  /** Registry source address, e.g. "hetznercloud/hcloud". */
  source: string;
  /** Version constraint, e.g. "~> 1.45". */
  version: string;
}

/** An input variable the generated config declares (credentials, account ids…). */
export interface TerraformVariable {
  /** Variable name, e.g. "hcloud_token" — referenced as `var.hcloud_token`. */
  name: string;
  description?: string;
  /** Marks the variable `sensitive = true` (API tokens, passwords). */
  sensitive?: boolean;
}

/**
 * A structured HCL value. `ref` is an unquoted expression (variable or
 * resource reference); everything else is serialized as an HCL literal.
 */
export type TerraformValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "ref"; expr: string }
  | { kind: "list"; items: TerraformValue[] }
  | { kind: "map"; entries: Record<string, TerraformValue> };

/** Shorthand constructors for {@link TerraformValue}. */
export const tf = {
  str: (value: string): TerraformValue => ({ kind: "string", value }),
  num: (value: number): TerraformValue => ({ kind: "number", value }),
  bool: (value: boolean): TerraformValue => ({ kind: "bool", value }),
  ref: (expr: string): TerraformValue => ({ kind: "ref", expr }),
  list: (items: TerraformValue[]): TerraformValue => ({ kind: "list", items }),
  map: (entries: Record<string, TerraformValue>): TerraformValue => ({ kind: "map", entries }),
};

/** One `resource` block in the generated configuration. */
export interface TerraformResourceBlock {
  /** Terraform resource type, e.g. "hcloud_server". */
  type: string;
  /**
   * Suggested local name. The host sanitizes it into a valid HCL identifier
   * and deduplicates across the bundle — plugins just pass the display name.
   */
  name: string;
  /** Attribute map. Keys are the provider's exact argument names. */
  attributes: Record<string, TerraformValue>;
  /**
   * The `terraform import` ID for adopting the live resource into state,
   * when the provider supports it. Rendered as a comment above the block.
   * `undefined` is accepted so plugins can pass `resource.externalId` directly.
   */
  importId?: string | undefined;
  /** Extra comment lines rendered above the block (caveats, attachment notes). */
  comments?: string[];
}

/** Result of mapping one stored resource. */
export interface TerraformExportResult {
  resource: TerraformResourceBlock;
  /** Additional variables this block references beyond the provider-level ones. */
  variables?: TerraformVariable[];
}

/**
 * Declared on `Plugin.terraformExport`. Everything except `mapResource` is
 * static declarative data (validated by `terraformExportCapabilitySchema`).
 */
export interface TerraformExportCapability {
  /** The provider requirement for `required_providers`. */
  provider: TerraformProviderRequirement;
  /**
   * Attributes of the generated `provider` block. Credential attributes must
   * be `ref` values pointing at variables declared in `variables`.
   */
  providerConfig: Record<string, TerraformValue>;
  /** Variables referenced by `providerConfig` (and shared by all blocks). */
  variables: TerraformVariable[];
  /** Resource type ids this capability can map. Anything else is "unsupported". */
  supportedResourceTypeIds: string[];
  /**
   * Map one stored resource to a Terraform block. Called with the persisted
   * `ResourceInstance` (fields + externalId + any cached outputs — no live
   * API access). Return `null` when this particular instance can't be
   * represented (missing required fields, provider-managed defaults, …).
   */
  mapResource(resource: ResourceInstance): TerraformExportResult | null;
}
