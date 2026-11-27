import { isRecord } from "../util/bytes.js";
import { type HclItem, hclItems, literalString } from "./hcl.js";
import { type HclValue, evaluate, fromJson } from "./expr.js";
import { resolveLocalSource } from "./discover.js";

/**
 * One directory's Terraform configuration as the estimate reads it: what it
 * declares, with each expression kept as written so it can be evaluated in
 * the scope of whoever calls the directory (the root, or a module call with
 * its arguments).
 *
 * Built from the files' text alone; nothing runs. A file that cannot be read
 * contributes nothing, as in discovery.
 */

/** An expression as written: HCL text, or a value from the JSON syntax. */
export type Expression = { readonly hcl: string } | { readonly json: unknown };

export interface VariableModel {
  readonly name: string;
  readonly default: Expression | null;
  readonly sensitive: boolean;
}

export interface ProviderModel {
  readonly name: string;
  readonly alias: string | null;
  readonly attributes: ReadonlyMap<string, Expression>;
}

export interface ResourceModel {
  readonly mode: "managed" | "data";
  readonly type: string;
  readonly name: string;
  readonly count: Expression | null;
  readonly forEach: Expression | null;
  /** `provider = aws.west`, as written. */
  readonly provider: string | null;
  readonly attributes: ReadonlyMap<string, Expression>;
  /** The first block of each nested block type, one level down (`root_block_device`). */
  readonly blocks: ReadonlyMap<string, ReadonlyMap<string, Expression>>;
}

export interface ModuleModel {
  readonly name: string;
  readonly source: string | null;
  readonly localPath: string | null;
  readonly version: string | null;
  readonly count: Expression | null;
  readonly forEach: Expression | null;
  readonly arguments: ReadonlyMap<string, Expression>;
}

export interface DirectoryModel {
  readonly path: string;
  readonly variables: ReadonlyMap<string, VariableModel>;
  readonly locals: ReadonlyMap<string, Expression>;
  readonly providers: readonly ProviderModel[];
  readonly resources: readonly ResourceModel[];
  readonly modules: readonly ModuleModel[];
  readonly outputCount: number;
  /** The configuration reads `terraform.workspace`: it behaves differently per CLI workspace. */
  readonly usesWorkspace: boolean;
}

const META_ARGUMENTS = new Set([
  "count",
  "for_each",
  "provider",
  "depends_on",
  "lifecycle",
  "provisioner",
  "connection",
  "source",
  "version",
  "providers",
]);

function attributesOf(items: readonly HclItem[]): Map<string, Expression> {
  const out = new Map<string, Expression>();
  for (const item of items) {
    if (item.kind === "attribute") out.set(item.name, { hcl: item.expression });
  }
  return out;
}

interface Building {
  variables: Map<string, VariableModel>;
  locals: Map<string, Expression>;
  providers: ProviderModel[];
  resources: ResourceModel[];
  modules: ModuleModel[];
  outputCount: number;
  usesWorkspace: boolean;
}

function readHclModel(path: string, source: string, into: Building): void {
  if (source.includes("terraform.workspace")) into.usesWorkspace = true;
  for (const item of hclItems(source)) {
    if (item.kind !== "block") continue;
    switch (item.type) {
      case "variable": {
        const name = item.labels[0];
        if (!name) break;
        const attributes = attributesOf(hclItems(item.body));
        const sensitive = attributes.get("sensitive");
        into.variables.set(name, {
          name,
          default: attributes.get("default") ?? null,
          sensitive: sensitive !== undefined && "hcl" in sensitive && sensitive.hcl === "true",
        });
        break;
      }
      case "locals":
        for (const [name, expression] of attributesOf(hclItems(item.body))) {
          into.locals.set(name, expression);
        }
        break;
      case "provider": {
        const name = item.labels[0];
        if (!name) break;
        const attributes = attributesOf(hclItems(item.body));
        const alias = attributes.get("alias");
        into.providers.push({
          name,
          alias: alias && "hcl" in alias ? literalString(alias.hcl) : null,
          attributes,
        });
        break;
      }
      case "resource":
      case "data": {
        const [type, name] = item.labels;
        if (!type || !name) break;
        const items = hclItems(item.body);
        const attributes = attributesOf(items);
        const blocks = new Map<string, Map<string, Expression>>();
        for (const inner of items) {
          if (inner.kind !== "block" || META_ARGUMENTS.has(inner.type)) continue;
          if (inner.type === "dynamic" || blocks.has(inner.type)) continue;
          blocks.set(inner.type, attributesOf(hclItems(inner.body)));
        }
        const provider = attributes.get("provider");
        into.resources.push({
          mode: item.type === "resource" ? "managed" : "data",
          type,
          name,
          count: attributes.get("count") ?? null,
          forEach: attributes.get("for_each") ?? null,
          provider: provider && "hcl" in provider ? provider.hcl.trim() : null,
          attributes: new Map([...attributes].filter(([key]) => !META_ARGUMENTS.has(key))),
          blocks,
        });
        break;
      }
      case "module": {
        const name = item.labels[0];
        if (!name) break;
        const attributes = attributesOf(hclItems(item.body));
        const sourceExpression = attributes.get("source");
        const source =
          sourceExpression && "hcl" in sourceExpression
            ? literalString(sourceExpression.hcl)
            : null;
        const version = attributes.get("version");
        into.modules.push({
          name,
          source,
          localPath: source === null ? null : resolveLocalSource(path, source),
          version: version && "hcl" in version ? literalString(version.hcl) : null,
          count: attributes.get("count") ?? null,
          forEach: attributes.get("for_each") ?? null,
          arguments: new Map([...attributes].filter(([key]) => !META_ARGUMENTS.has(key))),
        });
        break;
      }
      case "output":
        into.outputCount += 1;
        break;
    }
  }
}

/** `{ "a": {...} }` or `[{ "a": {...} }]`: the JSON syntax allows both for repeated blocks. */
function each(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).filter(isRecord);
}

function jsonAttributes(value: Record<string, unknown>): Map<string, Expression> {
  const out = new Map<string, Expression>();
  for (const [key, inner] of Object.entries(value)) {
    // Nested objects in a resource are blocks or object values; the attribute
    // reading below keeps scalars and lists, blocks are read separately.
    out.set(key, { json: inner });
  }
  return out;
}

function readJsonModel(path: string, source: string, into: Building): void {
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!isRecord(doc)) return;
  if (source.includes("terraform.workspace")) into.usesWorkspace = true;
  for (const variables of each(doc["variable"])) {
    for (const [name, value] of Object.entries(variables)) {
      const body = isRecord(value) ? value : {};
      into.variables.set(name, {
        name,
        default: "default" in body ? { json: body["default"] } : null,
        sensitive: body["sensitive"] === true,
      });
    }
  }
  for (const locals of each(doc["locals"])) {
    for (const [name, value] of Object.entries(locals)) into.locals.set(name, { json: value });
  }
  for (const providers of each(doc["provider"])) {
    for (const [name, value] of Object.entries(providers)) {
      for (const body of each(value)) {
        into.providers.push({
          name,
          alias: typeof body["alias"] === "string" ? body["alias"] : null,
          attributes: jsonAttributes(body),
        });
      }
    }
  }
  for (const mode of ["resource", "data"] as const) {
    for (const types of each(doc[mode])) {
      for (const [type, named] of Object.entries(types)) {
        for (const byName of each(named)) {
          for (const [name, value] of Object.entries(byName)) {
            for (const body of each(value)) {
              const attributes = new Map<string, Expression>();
              const blocks = new Map<string, Map<string, Expression>>();
              for (const [key, inner] of Object.entries(body)) {
                if (META_ARGUMENTS.has(key)) continue;
                const first = Array.isArray(inner) ? inner[0] : inner;
                if (isRecord(first) && !blocks.has(key)) blocks.set(key, jsonAttributes(first));
                attributes.set(key, { json: inner });
              }
              into.resources.push({
                mode: mode === "resource" ? "managed" : "data",
                type,
                name,
                count: "count" in body ? { json: body["count"] } : null,
                forEach: "for_each" in body ? { json: body["for_each"] } : null,
                provider: typeof body["provider"] === "string" ? body["provider"] : null,
                attributes,
                blocks,
              });
            }
          }
        }
      }
    }
  }
  for (const modules of each(doc["module"])) {
    for (const [name, value] of Object.entries(modules)) {
      const body = isRecord(value) ? value : {};
      const source = typeof body["source"] === "string" ? body["source"] : null;
      into.modules.push({
        name,
        source,
        localPath: source === null ? null : resolveLocalSource(path, source),
        version: typeof body["version"] === "string" ? body["version"] : null,
        count: "count" in body ? { json: body["count"] } : null,
        forEach: "for_each" in body ? { json: body["for_each"] } : null,
        arguments: new Map(
          Object.entries(body)
            .filter(([key]) => !META_ARGUMENTS.has(key))
            .map(([key, inner]) => [key, { json: inner }]),
        ),
      });
    }
  }
  for (const outputs of each(doc["output"])) into.outputCount += Object.keys(outputs).length;
}

/**
 * The model of one directory from its Terraform files (`name` to text). A
 * file that cannot be read is skipped; `unreadable` names it.
 */
export function directoryModel(
  path: string,
  files: ReadonlyArray<{ readonly name: string; readonly text: string }>,
): { readonly model: DirectoryModel; readonly unreadable: readonly string[] } {
  const into: Building = {
    variables: new Map(),
    locals: new Map(),
    providers: [],
    resources: [],
    modules: [],
    outputCount: 0,
    usesWorkspace: false,
  };
  const unreadable: string[] = [];
  for (const file of files) {
    try {
      if (file.name.endsWith(".json")) readJsonModel(path, file.text, into);
      else readHclModel(path, file.text, into);
    } catch {
      unreadable.push(file.name);
    }
  }
  return { model: { path, ...into }, unreadable };
}

/**
 * Values a `.tfvars` file (HCL) or `.tfvars.json` file sets. Terraform loads
 * `terraform.tfvars`, `terraform.tfvars.json` and `*.auto.tfvars(.json)` in
 * the root on its own; nothing else is read.
 */
export function tfvarsValues(name: string, text: string): Map<string, HclValue> {
  const out = new Map<string, HclValue>();
  if (name.endsWith(".json")) {
    try {
      const doc: unknown = JSON.parse(text);
      if (isRecord(doc)) {
        for (const [key, value] of Object.entries(doc)) out.set(key, fromJson(value));
      }
    } catch {
      // Unreadable: sets nothing.
    }
    return out;
  }
  try {
    for (const item of hclItems(text)) {
      if (item.kind === "attribute") out.set(item.name, evaluate(item.expression));
    }
  } catch {
    // Unreadable: sets nothing.
  }
  return out;
}

/** Whether Terraform loads a variables file on its own, in a root. */
export function isAutoTfvars(name: string): boolean {
  return (
    name === "terraform.tfvars" ||
    name === "terraform.tfvars.json" ||
    name.endsWith(".auto.tfvars") ||
    name.endsWith(".auto.tfvars.json")
  );
}
