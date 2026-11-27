import { clamp, isRecord } from "../util/bytes.js";

/**
 * The resource instances in a state document, reduced to what ties one to an
 * Infrawrench resource: its address, its type, its provider and the values
 * that identify it. No other attribute leaves this function, so nothing a
 * state marks sensitive is ever in the result.
 *
 * Reads a raw state (format version 4), which is what the backend stores.
 */

export interface StateResourceInstance {
  /** `module.vpc.aws_subnet.private[0]` */
  readonly address: string;
  /** `module.vpc`, or null in the root module. */
  readonly module: string | null;
  readonly type: string;
  readonly name: string;
  /** The `count` index or `for_each` key. */
  readonly indexKey: string | number | null;
  /** `registry.terraform.io/hashicorp/aws`, or null when the state does not say. */
  readonly provider: string | null;
  /**
   * Lower-cased values of the attributes providers identify a resource by:
   * `id`, `arn` and `self_link`. The same three, normalised the same way, as
   * the app's IaC reconciliation uses, so the two agree on what matches.
   */
  readonly identifiers: readonly string[];
  /** The `name` attribute or a `Name` tag, to show an instance nothing matched. */
  readonly label: string | null;
}

export interface StateResources {
  readonly instances: readonly StateResourceInstance[];
  /** Data sources in the state. They are read, not managed, and are left out. */
  readonly dataSources: number;
  /** Instances past {@link MAX_STATE_INSTANCES}, left out. */
  readonly omitted: number;
}

export const MAX_STATE_INSTANCES = 20_000;
const MAX_IDENTIFIER = 2048;

/** Attribute keys that identify a resource well enough to match on. */
const IDENTITY_KEYS = ["id", "arn", "self_link"] as const;

function identifiers(attributes: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of IDENTITY_KEYS) {
    const value = attributes[key];
    const normalized =
      typeof value === "string" && value !== "" && value.length <= MAX_IDENTIFIER
        ? value.toLowerCase()
        : typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : null;
    if (normalized !== null && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function label(attributes: Record<string, unknown>): string | null {
  const name = attributes["name"];
  if (typeof name === "string" && name !== "") return clamp(name, 256);
  const tags = attributes["tags"];
  if (isRecord(tags) && typeof tags["Name"] === "string" && tags["Name"] !== "") {
    return clamp(tags["Name"], 256);
  }
  return null;
}

/** `provider["registry.terraform.io/hashicorp/aws"].west` as `registry.terraform.io/hashicorp/aws`. */
export function providerSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /provider\["([^"]+)"\]/.exec(value);
  return match ? clamp(match[1]!, 256) : null;
}

function formatIndex(indexKey: string | number | null): string {
  if (indexKey === null) return "";
  return typeof indexKey === "number" ? `[${indexKey}]` : `[${JSON.stringify(indexKey)}]`;
}

export function stateResourceInstances(document: unknown): StateResources {
  const instances: StateResourceInstance[] = [];
  let dataSources = 0;
  let omitted = 0;
  const resources =
    isRecord(document) && Array.isArray(document["resources"]) ? document["resources"] : [];
  for (const resource of resources) {
    if (!isRecord(resource)) continue;
    const type = resource["type"];
    const name = resource["name"];
    if (typeof type !== "string" || typeof name !== "string") continue;
    if (resource["mode"] === "data") {
      dataSources += 1;
      continue;
    }
    const module = typeof resource["module"] === "string" ? resource["module"] : null;
    const provider = providerSource(resource["provider"]);
    const list = Array.isArray(resource["instances"]) ? resource["instances"] : [];
    for (const instance of list) {
      // A deposed object is the old half of a create-before-destroy that did
      // not finish: it is on its way out, not what the address manages.
      if (!isRecord(instance) || typeof instance["deposed"] === "string") continue;
      if (instances.length >= MAX_STATE_INSTANCES) {
        omitted += 1;
        continue;
      }
      const rawIndex = instance["index_key"];
      const indexKey =
        typeof rawIndex === "number" || typeof rawIndex === "string" ? rawIndex : null;
      const attributes = isRecord(instance["attributes"]) ? instance["attributes"] : {};
      const head = `${type}.${name}${formatIndex(indexKey)}`;
      instances.push({
        address: clamp(module ? `${module}.${head}` : head, 1024),
        module,
        type: clamp(type, 256),
        name: clamp(name, 256),
        indexKey,
        provider,
        identifiers: identifiers(attributes),
        label: label(attributes),
      });
    }
  }
  return { instances, dataSources, omitted };
}
