import { isRecord } from "../util/bytes.js";
import { hclItems, literalString } from "./hcl.js";

/**
 * Finding the Terraform roots in a repository: the directories someone runs
 * `terraform plan` in, as opposed to the modules those call. A repository's
 * Infrastructure tab offers each root as a workspace.
 *
 * Nothing says which is which, so it is read from what a directory declares:
 *
 * 1. A `backend` (or `cloud`) block makes a root: only a root has state.
 * 2. Otherwise a directory another one calls as a local module is a module.
 * 3. Otherwise a `provider` block makes a root: modules receive providers.
 * 4. Otherwise a directory under a `modules/` folder is a module nobody here
 *    calls yet (a published one, or one used from another repository).
 * 5. Otherwise it is a root if it declares anything to run.
 *
 * `required_providers` is recorded but decides nothing: modules pin their
 * providers as often as roots do.
 */

export interface TreeNode {
  readonly name: string;
  readonly kind: "file" | "directory";
}

/**
 * A repository's tree at one commit. Paths are relative to the repository,
 * `/`-separated, with no leading or trailing slash; the top is `""`.
 */
export interface TreeReader {
  /** A directory's entries. Empty for a path that is not a directory. */
  list(path: string): Promise<readonly TreeNode[]>;
  /** A file's bytes, or null when there is no such file. */
  read(path: string): Promise<Uint8Array | null>;
}

export interface DiscoverLimits {
  /** Directories walked before giving up on the rest. Default 5000. */
  readonly maxDirectories?: number;
  /** How deep below the top to look. Default 12. */
  readonly maxDepth?: number;
  /** Terraform files read per directory. Default 200. */
  readonly maxFilesPerDirectory?: number;
  /** Files larger than this are not read. Default 1 MiB. */
  readonly maxFileBytes?: number;
}

export type RootReason =
  | "backend"
  | "provider-block"
  | "unreferenced"
  | "called-as-module"
  | "modules-directory"
  | "nothing-to-run";

export interface ModuleCall {
  readonly name: string;
  /** The `source` as written, or null when it is not a plain string. */
  readonly source: string | null;
  /** For a `./` or `../` source: the directory it names, relative to the repository. */
  readonly localPath: string | null;
}

export interface TerraformVariable {
  readonly name: string;
  /** No `default`: a run has to supply it (`TF_VAR_<name>`). */
  readonly required: boolean;
  readonly sensitive: boolean;
}

export interface TerraformDirectory {
  /** Relative to the repository; `""` for its top. */
  readonly path: string;
  readonly kind: "root" | "module";
  /** Why, in the order the rules above were met. */
  readonly reasons: readonly RootReason[];
  /** The declared backend's type (`s3`, `http`, `cloud`), or null. */
  readonly backend: string | null;
  /** Local names of the `provider` blocks. */
  readonly providers: readonly string[];
  /** `required_providers`: local name to source (`hashicorp/aws`), or null where none is given. */
  readonly requiredProviders: Readonly<Record<string, string | null>>;
  readonly requiredVersion: string | null;
  readonly moduleCalls: readonly ModuleCall[];
  /** Directories here that call this one as a module. */
  readonly calledBy: readonly string[];
  readonly variables: readonly TerraformVariable[];
  readonly resourceCount: number;
  readonly dataSourceCount: number;
  /** Files that could not be read as HCL, with why. Their contents count for nothing. */
  readonly unreadable: readonly { readonly file: string; readonly reason: string }[];
}

export interface DiscoveryResult {
  /** Every directory holding Terraform files, sorted by path. */
  readonly directories: readonly TerraformDirectory[];
  /** True when a limit stopped the walk before it had seen everything. */
  readonly truncated: boolean;
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "vendor"]);

function isTerraformFile(name: string): boolean {
  return (
    name.endsWith(".tf") ||
    name.endsWith(".tofu") ||
    name.endsWith(".tf.json") ||
    name.endsWith(".tofu.json")
  );
}

function join(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

/** `a/b` + `../c` = `a/c`. Null when the source climbs out of the repository. */
export function resolveLocalSource(directory: string, source: string): string | null {
  if (!source.startsWith("./") && !source.startsWith("../") && source !== "." && source !== "..") {
    return null;
  }
  const parts = directory === "" ? [] : directory.split("/");
  // A `//subdir` suffix is for registry and git sources; a local path has none.
  for (const step of source.split("/")) {
    if (step === "" || step === ".") continue;
    if (step === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(step);
  }
  return parts.join("/");
}

interface Declared {
  backend: string | null;
  providers: Set<string>;
  requiredProviders: Record<string, string | null>;
  requiredVersion: string | null;
  moduleCalls: ModuleCall[];
  variables: TerraformVariable[];
  resourceCount: number;
  dataSourceCount: number;
  unreadable: { file: string; reason: string }[];
}

function readHcl(directory: string, source: string, into: Declared): void {
  for (const item of hclItems(source)) {
    if (item.kind !== "block") continue;
    switch (item.type) {
      case "terraform":
        for (const inner of hclItems(item.body)) {
          if (inner.kind === "attribute") {
            if (inner.name === "required_version") {
              into.requiredVersion = literalString(inner.expression) ?? into.requiredVersion;
            }
          } else if (inner.type === "backend") {
            into.backend = inner.labels[0] ?? into.backend;
          } else if (inner.type === "cloud") {
            into.backend = "cloud";
          } else if (inner.type === "required_providers") {
            for (const provider of hclItems(inner.body)) {
              if (provider.kind !== "attribute") continue;
              const source = /(?:^|[\s{,])source\s*=\s*"([^"$%\\]+)"/.exec(provider.expression);
              into.requiredProviders[provider.name] = source?.[1] ?? null;
            }
          }
        }
        break;
      case "provider":
        if (item.labels[0]) into.providers.add(item.labels[0]);
        break;
      case "module": {
        const name = item.labels[0];
        if (!name) break;
        const attribute = hclItems(item.body).find(
          (inner) => inner.kind === "attribute" && inner.name === "source",
        );
        const source = attribute?.kind === "attribute" ? literalString(attribute.expression) : null;
        into.moduleCalls.push({
          name,
          source,
          localPath: source === null ? null : resolveLocalSource(directory, source),
        });
        break;
      }
      case "variable": {
        const name = item.labels[0];
        if (!name) break;
        const attributes = hclItems(item.body);
        const has = (key: string) =>
          attributes.find((inner) => inner.kind === "attribute" && inner.name === key);
        const sensitive = has("sensitive");
        into.variables.push({
          name,
          required: has("default") === undefined,
          sensitive: sensitive?.kind === "attribute" && sensitive.expression === "true",
        });
        break;
      }
      case "resource":
        into.resourceCount += 1;
        break;
      case "data":
        into.dataSourceCount += 1;
        break;
    }
  }
}

/** The JSON syntax (`*.tf.json`): the same declarations as nested objects. */
function readJson(directory: string, source: string, into: Declared): void {
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch {
    // Never the parser's own message: it quotes the text it could not read.
    throw new Error("The file is not valid JSON.");
  }
  if (!isRecord(doc)) return;
  const each = (value: unknown): Record<string, unknown>[] =>
    (Array.isArray(value) ? value : [value]).filter(isRecord);

  for (const terraform of each(doc["terraform"])) {
    for (const backend of each(terraform["backend"])) {
      into.backend = Object.keys(backend)[0] ?? into.backend;
    }
    if (terraform["cloud"] !== undefined) into.backend = "cloud";
    if (typeof terraform["required_version"] === "string") {
      into.requiredVersion = terraform["required_version"];
    }
    for (const required of each(terraform["required_providers"])) {
      for (const [name, value] of Object.entries(required)) {
        into.requiredProviders[name] =
          isRecord(value) && typeof value["source"] === "string" ? value["source"] : null;
      }
    }
  }
  for (const provider of each(doc["provider"])) {
    for (const name of Object.keys(provider)) into.providers.add(name);
  }
  for (const modules of each(doc["module"])) {
    for (const [name, value] of Object.entries(modules)) {
      const source =
        isRecord(value) && typeof value["source"] === "string" ? value["source"] : null;
      into.moduleCalls.push({
        name,
        source,
        localPath: source === null ? null : resolveLocalSource(directory, source),
      });
    }
  }
  for (const variables of each(doc["variable"])) {
    for (const [name, value] of Object.entries(variables)) {
      into.variables.push({
        name,
        required: !(isRecord(value) && "default" in value),
        sensitive: isRecord(value) && value["sensitive"] === true,
      });
    }
  }
  const count = (value: unknown) =>
    each(value).reduce(
      (sum, types) =>
        sum +
        Object.values(types).reduce<number>(
          (n, v) => n + (isRecord(v) ? Object.keys(v).length : 0),
          0,
        ),
      0,
    );
  into.resourceCount += count(doc["resource"]);
  into.dataSourceCount += count(doc["data"]);
}

function classify(
  path: string,
  declared: Declared,
  calledBy: readonly string[],
): { kind: "root" | "module"; reasons: RootReason[] } {
  if (declared.backend !== null) {
    return { kind: "root", reasons: ["backend"] };
  }
  if (calledBy.length > 0) return { kind: "module", reasons: ["called-as-module"] };
  if (declared.providers.size > 0) return { kind: "root", reasons: ["provider-block"] };
  if (path.split("/").includes("modules"))
    return { kind: "module", reasons: ["modules-directory"] };
  const runs = declared.resourceCount + declared.dataSourceCount + declared.moduleCalls.length > 0;
  return runs
    ? { kind: "root", reasons: ["unreferenced"] }
    : { kind: "module", reasons: ["nothing-to-run"] };
}

/** Reads the tree and says, for every directory with Terraform files, whether it is a root. */
export async function discoverTerraformDirectories(
  tree: TreeReader,
  limits: DiscoverLimits = {},
): Promise<DiscoveryResult> {
  const maxDirectories = limits.maxDirectories ?? 5000;
  const maxDepth = limits.maxDepth ?? 12;
  const maxFiles = limits.maxFilesPerDirectory ?? 200;
  const maxFileBytes = limits.maxFileBytes ?? 1024 * 1024;

  const found = new Map<string, Declared>();
  let truncated = false;
  let walked = 0;
  const queue: { path: string; depth: number }[] = [{ path: "", depth: 0 }];

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (walked >= maxDirectories) {
      truncated = true;
      break;
    }
    walked += 1;
    const { path, depth } = next;
    const entries = await tree.list(path);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.kind === "directory") {
        // Dot directories hold tooling (`.terraform`, `.git`), never roots of their own.
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (depth + 1 > maxDepth) truncated = true;
        // Never queue more than can be walked: a few shared trees with
        // thousands of entries each would otherwise queue millions of paths.
        else if (walked + queue.length >= maxDirectories) truncated = true;
        else queue.push({ path: join(path, entry.name), depth: depth + 1 });
      } else if (isTerraformFile(entry.name) && !entry.name.startsWith(".")) {
        files.push(entry.name);
      }
    }
    if (files.length === 0) continue;
    files.sort();
    if (files.length > maxFiles) truncated = true;

    const declared: Declared = {
      backend: null,
      providers: new Set(),
      requiredProviders: {},
      requiredVersion: null,
      moduleCalls: [],
      variables: [],
      resourceCount: 0,
      dataSourceCount: 0,
      unreadable: [],
    };
    for (const file of files.slice(0, maxFiles)) {
      const bytes = await tree.read(join(path, file));
      if (!bytes) continue;
      if (bytes.length > maxFileBytes) {
        declared.unreadable.push({ file, reason: "The file is too large to read." });
        continue;
      }
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (file.endsWith(".json")) readJson(path, source, declared);
        else readHcl(path, source, declared);
      } catch (error) {
        declared.unreadable.push({
          file,
          reason: error instanceof Error ? error.message : "The file could not be read.",
        });
      }
    }
    found.set(path, declared);
  }

  const calledBy = new Map<string, string[]>();
  for (const [path, declared] of found) {
    for (const call of declared.moduleCalls) {
      if (call.localPath === null || call.localPath === path) continue;
      const callers = calledBy.get(call.localPath) ?? [];
      if (!callers.includes(path)) callers.push(path);
      calledBy.set(call.localPath, callers);
    }
  }

  const directories: TerraformDirectory[] = [];
  for (const path of [...found.keys()].sort()) {
    const declared = found.get(path)!;
    const callers = (calledBy.get(path) ?? []).sort();
    directories.push({
      path,
      ...classify(path, declared, callers),
      backend: declared.backend,
      providers: [...declared.providers].sort(),
      requiredProviders: declared.requiredProviders,
      requiredVersion: declared.requiredVersion,
      moduleCalls: declared.moduleCalls,
      calledBy: callers,
      variables: declared.variables,
      resourceCount: declared.resourceCount,
      dataSourceCount: declared.dataSourceCount,
      unreadable: declared.unreadable,
    });
  }
  return { directories, truncated };
}

/** Only the roots: what the Infrastructure tab offers as workspaces. */
export async function discoverTerraformRoots(
  tree: TreeReader,
  limits?: DiscoverLimits,
): Promise<{ readonly roots: readonly TerraformDirectory[]; readonly truncated: boolean }> {
  const { directories, truncated } = await discoverTerraformDirectories(tree, limits);
  return { roots: directories.filter((directory) => directory.kind === "root"), truncated };
}

/** The longest name a workspace may have. */
export const MAX_WORKSPACE_NAME = 63;

/** A workspace name: it is a URL segment, a concurrency group and part of an R2 key. */
export function isWorkspaceName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name) && name.length <= MAX_WORKSPACE_NAME;
}

/**
 * A workspace name for a root, from its path: `infra/envs/prod` is
 * `infra-envs-prod`, the repository's top is `default`. `taken` are names
 * already in use; the answer is none of them.
 */
export function suggestWorkspaceName(path: string, taken: Iterable<string> = []): string {
  // Trimmed by index, on a bounded piece of the path: `-+$` tried from every
  // dash of a long run is quadratic.
  const cleaned = path
    .slice(0, 4 * MAX_WORKSPACE_NAME)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  let start = 0;
  let end = cleaned.length;
  while (start < end && (cleaned[start] === "-" || cleaned[start] === "_")) start += 1;
  while (end > start && cleaned[end - 1] === "-") end -= 1;
  const base = cleaned.slice(start, end).slice(0, MAX_WORKSPACE_NAME - 4) || "default";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
