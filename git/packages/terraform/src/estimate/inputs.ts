import {
  type HclValue,
  EMPTY_SCOPE,
  type Scope,
  UNKNOWN,
  evaluate,
  fromJson,
  hasUnknown,
} from "../roots/expr.js";
import type { DirectoryModel, Expression, ResourceModel } from "../roots/model.js";

/**
 * What pricing a root from its configuration needs: every managed resource
 * the root would create, through its local modules, with how many instances
 * and the attribute values that can be read without running anything.
 *
 * Values come from literals, variables (an auto-loaded `.tfvars` in the root,
 * else the variable's `default`) and locals. A variable marked `sensitive`
 * is never read. `count` and `for_each` are resolved when they evaluate; a
 * resource whose count does not is kept with `count: null`, so the pricer
 * says so instead of guessing. Attributes whose names look like credentials
 * are left out entirely, known or not.
 */

/** A value pricing may read: a scalar, or a short list of strings (`instance_types`). */
export type ConfigurationValue = string | number | boolean | readonly string[];

export interface ConfigurationResource {
  /** `module.db.aws_db_instance.main`, with `["a", "b"]` when its instances differ. */
  readonly address: string;
  readonly type: string;
  /** The provider's local name (`aws`), from `provider =` or the type's prefix. */
  readonly provider: string;
  /** Instances. Null when `count` or `for_each` (its own or a module's) is not known. */
  readonly count: number | null;
  /** The provider configuration's `region`, when it is set and known. */
  readonly providerRegion: string | null;
  /** Known values, by attribute name; a nested block's as `block.attribute`. */
  readonly attributes: Readonly<Record<string, ConfigurationValue>>;
  /** Attributes that are set but whose value is not known from the configuration. */
  readonly unknownAttributes: readonly string[];
}

export interface ConfigurationPricingInputs {
  readonly root: string;
  readonly resources: readonly ConfigurationResource[];
  /** Modules from a registry or Git: their resources are not read. */
  readonly unreadModules: ReadonlyArray<{
    readonly address: string;
    readonly source: string | null;
  }>;
  /** A limit stopped the walk: there are resources this does not list. */
  readonly truncated: boolean;
  /**
   * Resources and module calls whose `count` or `for_each` is zero with the
   * values the repository holds (defaults, committed `.tfvars`): switched off
   * unless a run sets a variable the repository does not. At most
   * {@link MAX_INACTIVE_LISTED}; `inactiveCount` is all of them.
   */
  readonly inactive: readonly string[];
  readonly inactiveCount: number;
}

export const MAX_INACTIVE_LISTED = 200;

/** Resources listed per root, after instances with the same values are folded together. */
export const MAX_CONFIGURATION_RESOURCES = 2000;
/** Module instances evaluated per root. */
const MAX_MODULE_INSTANCES = 200;
/** Instances of one resource or module evaluated one by one; past this they are folded. */
const MAX_EXPANDED_INSTANCES = 50;
const MAX_MODULE_DEPTH = 10;
const MAX_VALUE_LENGTH = 256;
const MAX_LIST_ITEMS = 16;

/** Names of attributes never read: credentials, keys, user data. */
const SECRET_NAME =
  /(pass(word|phrase)?|secret|token|private|credential|user_data|cert|key_material|api_key|access_key|auth|sas)/i;

/** Providers built into Terraform or of no account: nothing they create is billed. */
const NO_ACCOUNT_PROVIDERS = new Set([
  "terraform",
  "null",
  "random",
  "tls",
  "time",
  "local",
  "external",
  "archive",
  "http",
  "cloudinit",
  "template",
]);

/** A provider's local name: `provider = aws.west` gives `aws`, else the type's prefix. */
export function providerOf(resource: Pick<ResourceModel, "type" | "provider">): {
  readonly name: string;
  readonly alias: string | null;
} {
  if (resource.provider) {
    const [name, alias] = resource.provider.split(".");
    if (name) return { name, alias: alias ?? null };
  }
  const underscore = resource.type.indexOf("_");
  return {
    name: underscore === -1 ? resource.type : resource.type.slice(0, underscore),
    alias: null,
  };
}

/** An expression's value in a scope. A string from the JSON syntax is read as a template. */
export function valueOf(expression: Expression, scope: Scope): HclValue {
  if ("hcl" in expression) return evaluate(expression.hcl, scope);
  const json = (value: unknown, depth: number): HclValue => {
    if (depth > 32) return UNKNOWN;
    if (typeof value === "string") {
      return value.includes("${") || value.includes("%{")
        ? evaluate(JSON.stringify(value), scope)
        : value;
    }
    if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
    if (typeof value === "object" && value !== null) {
      const out: Record<string, HclValue> = {};
      for (const [key, item] of Object.entries(value)) out[key] = json(item, depth + 1);
      return out;
    }
    return fromJson(value);
  };
  return json(expression.json, 0);
}

interface Instance {
  readonly key: string | null;
  readonly scope: Scope;
}

/** The instances `count` / `for_each` make, or null with one scope when that is not known. */
function instancesOf(
  count: Expression | null,
  forEach: Expression | null,
  scope: Scope,
): { readonly count: number | null; readonly instances: readonly Instance[] } {
  if (count !== null) {
    const value = valueOf(count, scope);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { count: null, instances: [{ key: null, scope }] };
    }
    const n = Math.floor(value);
    if (n > MAX_EXPANDED_INSTANCES) return { count: n, instances: [{ key: null, scope }] };
    return {
      count: n,
      instances: Array.from({ length: n }, (_, index) => ({
        key: String(index),
        scope: { ...scope, countIndex: index },
      })),
    };
  }
  if (forEach !== null) {
    const value = valueOf(forEach, scope);
    let entries: Array<[string, HclValue]> | null = null;
    if (Array.isArray(value) && !hasUnknown(value)) {
      entries = value.map((item) => [typeof item === "string" ? item : JSON.stringify(item), item]);
    } else if (typeof value === "object" && value !== null) {
      entries = Object.entries(value as Record<string, HclValue>);
    }
    if (entries === null) return { count: null, instances: [{ key: null, scope }] };
    if (entries.length > MAX_EXPANDED_INSTANCES) {
      return { count: entries.length, instances: [{ key: null, scope }] };
    }
    return {
      count: entries.length,
      instances: entries.map(([key, item]) => ({
        key: JSON.stringify(key),
        scope: {
          variable: scope.variable,
          local: scope.local,
          each: { key, value: item },
        },
      })),
    };
  }
  return { count: 1, instances: [{ key: null, scope }] };
}

/** A value pricing may keep, or undefined to leave it out (unset, or a shape it does not read). */
function keepable(value: HclValue): ConfigurationValue | undefined {
  if (typeof value === "string") return value.length <= MAX_VALUE_LENGTH ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.length <= MAX_LIST_ITEMS) {
    if (value.every((item) => typeof item === "string" && item.length <= MAX_VALUE_LENGTH)) {
      return value as string[];
    }
  }
  return undefined;
}

function readAttributes(
  resource: ResourceModel,
  scope: Scope,
): { attributes: Record<string, ConfigurationValue>; unknown: string[] } {
  const attributes: Record<string, ConfigurationValue> = {};
  const unknown: string[] = [];
  const read = (name: string, expression: Expression) => {
    if (SECRET_NAME.test(name)) return;
    const value = valueOf(expression, scope);
    if (value === null) return;
    if (hasUnknown(value)) {
      unknown.push(name);
      return;
    }
    const kept = keepable(value);
    if (kept !== undefined) attributes[name] = kept;
  };
  for (const [name, expression] of resource.attributes) {
    if (resource.blocks.has(name) && "json" in expression) continue;
    read(name, expression);
  }
  for (const [block, inner] of resource.blocks) {
    if (SECRET_NAME.test(block)) continue;
    for (const [name, expression] of inner) read(`${block}.${name}`, expression);
  }
  return { attributes, unknown: unknown.sort() };
}

/** How a module instance's variables are answered. */
interface ModuleContext {
  readonly model: DirectoryModel;
  /** Values the caller passed, already evaluated. */
  readonly arguments: ReadonlyMap<string, HclValue>;
  /** Auto-loaded `.tfvars` values: the root only. */
  readonly tfvars: ReadonlyMap<string, HclValue>;
}

function scopeFor(context: ModuleContext): Scope {
  const locals = new Map<string, HclValue>();
  const evaluating = new Set<string>();
  const scope: Scope = {
    variable: (name) => {
      const declared = context.model.variables.get(name);
      if (!declared || declared.sensitive) return UNKNOWN;
      if (context.arguments.has(name)) return context.arguments.get(name)!;
      if (context.tfvars.has(name)) return context.tfvars.get(name)!;
      return declared.default === null ? UNKNOWN : valueOf(declared.default, EMPTY_SCOPE);
    },
    local: (name) => {
      const known = locals.get(name);
      if (known !== undefined) return known;
      const expression = context.model.locals.get(name);
      if (!expression || evaluating.has(name)) return UNKNOWN;
      evaluating.add(name);
      try {
        const value = valueOf(expression, scope);
        locals.set(name, value);
        return value;
      } finally {
        evaluating.delete(name);
      }
    },
  };
  return scope;
}

/**
 * The pricing inputs of the root at `root`. `models` has the root and every
 * directory it may call (`directoryModel`), by path; `tfvars` the values the
 * root's auto-loaded variable files set.
 */
export function configurationPricingInputs(
  root: string,
  models: ReadonlyMap<string, DirectoryModel>,
  tfvars: ReadonlyMap<string, HclValue> = new Map(),
): ConfigurationPricingInputs {
  const resources: ConfigurationResource[] = [];
  const unreadModules: { address: string; source: string | null }[] = [];
  const inactive: string[] = [];
  let inactiveCount = 0;
  const switchedOff = (address: string) => {
    inactiveCount += 1;
    if (inactive.length < MAX_INACTIVE_LISTED) inactive.push(address);
  };
  let truncated = false;
  let moduleInstances = 0;

  const walk = (
    context: ModuleContext,
    prefix: string,
    multiplier: number | null,
    /** Regions of the caller's provider configurations, by `name` or `name.alias`. */
    inherited: ReadonlyMap<string, string | null>,
    depth: number,
    stack: readonly string[],
  ): void => {
    const scope = scopeFor(context);
    const regions = new Map(inherited);
    for (const provider of context.model.providers) {
      const region = provider.attributes.get("region");
      const value = region ? valueOf(region, scope) : null;
      regions.set(
        provider.alias ? `${provider.name}.${provider.alias}` : provider.name,
        typeof value === "string" ? value : null,
      );
    }

    for (const resource of context.model.resources) {
      if (resource.mode !== "managed") continue;
      const provider = providerOf(resource);
      if (NO_ACCOUNT_PROVIDERS.has(provider.name)) continue;
      if (resources.length >= MAX_CONFIGURATION_RESOURCES) {
        truncated = true;
        return;
      }
      const base = `${prefix}${resource.type}.${resource.name}`;
      const { count, instances } = instancesOf(resource.count, resource.forEach, scope);
      const total = count === null || multiplier === null ? null : count * multiplier;
      if (total === 0) {
        switchedOff(base);
        continue;
      }
      const providerRegion =
        regions.get(provider.alias ? `${provider.name}.${provider.alias}` : provider.name) ?? null;

      // Instances with the same values are one line.
      const groups = new Map<
        string,
        {
          keys: (string | null)[];
          attributes: Record<string, ConfigurationValue>;
          unknown: string[];
        }
      >();
      for (const instance of instances) {
        const read = readAttributes(resource, instance.scope);
        const signature = JSON.stringify([read.attributes, read.unknown]);
        const group = groups.get(signature);
        if (group) group.keys.push(instance.key);
        else groups.set(signature, { keys: [instance.key], ...read });
      }
      const expanded = instances.length > 1 || instances[0]?.key !== null;
      for (const group of groups.values()) {
        const instancesHere = expanded ? group.keys.length : 1;
        const addressed =
          groups.size > 1
            ? `${base}[${group.keys.filter((key) => key !== null).join(", ")}]`
            : base;
        resources.push({
          address: addressed,
          type: resource.type,
          provider: provider.name,
          count: total === null ? null : expanded ? instancesHere * (multiplier ?? 0) : total,
          providerRegion,
          attributes: group.attributes,
          unknownAttributes: group.unknown,
        });
      }
    }

    for (const call of context.model.modules) {
      const address = `${prefix}module.${call.name}`;
      const target = call.localPath === null ? undefined : models.get(call.localPath);
      if (!target) {
        unreadModules.push({ address, source: call.source });
        continue;
      }
      if (depth >= MAX_MODULE_DEPTH || stack.includes(target.path)) {
        unreadModules.push({ address, source: call.source });
        continue;
      }
      const { count, instances } = instancesOf(call.count, call.forEach, scope);
      if (count === 0) {
        switchedOff(address);
        continue;
      }
      const expanded = instances.length > 1 || instances[0]?.key !== null;
      for (const instance of instances) {
        moduleInstances += 1;
        if (moduleInstances > MAX_MODULE_INSTANCES) {
          truncated = true;
          return;
        }
        const args = new Map<string, HclValue>();
        for (const [name, expression] of call.arguments) {
          args.set(name, valueOf(expression, instance.scope));
        }
        const inner =
          expanded && instance.key !== null ? `${address}[${instance.key}].` : `${address}.`;
        const times =
          multiplier === null || count === null ? null : expanded ? multiplier : multiplier * count;
        walk(
          { model: target, arguments: args, tfvars: new Map() },
          inner,
          times,
          regions,
          depth + 1,
          [...stack, context.model.path],
        );
        if (truncated) return;
      }
    }
  };

  const model = models.get(root);
  if (model) walk({ model, arguments: new Map(), tfvars }, "", 1, new Map(), 0, []);
  return { root, resources, unreadModules, truncated, inactive, inactiveCount };
}
