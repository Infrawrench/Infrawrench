import { type HclValue } from "../roots/expr.js";
import {
  type DiscoveryResult,
  type TerraformDirectory,
  type TreeNode,
  type TreeReader,
  discoverTerraformDirectories,
} from "../roots/discover.js";
import { type DirectoryModel, directoryModel, isAutoTfvars, tfvarsValues } from "../roots/model.js";
import { type ConfigurationPricingInputs, configurationPricingInputs } from "../estimate/inputs.js";

/**
 * Scanning a repository's Terraform at one commit, from a snapshot of its
 * Terraform files: which directories are roots, what each declares, and what
 * pricing its configuration needs.
 *
 * The storage takes the snapshot in one walk beside the data (the worker's
 * `terraformFiles` reader method), so a repository of any size costs one
 * call, and everything here runs in memory over it. The answer depends only
 * on the files, so it is cached by the commit's tree and
 * {@link TERRAFORM_SCANNER_VERSION}.
 */

/** Bumped when the scan's answer for the same files changes: older cached scans are redone. */
export const TERRAFORM_SCANNER_VERSION = 1;

export interface TerraformSnapshotFile {
  /** Relative to the repository, `/`-separated. */
  readonly path: string;
  /** Null when the file was not read (too large, binary, or past the byte budget). */
  readonly text: string | null;
  readonly size: number;
}

export interface TerraformSnapshot {
  readonly files: readonly TerraformSnapshotFile[];
  /** A limit stopped the walk or the reading: some Terraform files are missing. */
  readonly truncated: boolean;
}

/** Limits of a snapshot, which the storage's walk applies. */
export const SNAPSHOT_LIMITS = {
  /** Directories walked. */
  maxDirectories: 20_000,
  /** Terraform files kept. */
  maxFiles: 3000,
  /** A file larger than this is listed, not read. */
  maxFileBytes: 1024 * 1024,
  /** Bytes read in all. */
  maxTotalBytes: 8 * 1024 * 1024,
} as const;

/** Directories never walked: tooling and vendored code, never roots of their own. */
export function isSkippedDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "vendor";
}

/** Whether a file is one a scan reads: configuration, variable files and the lock file. */
export function isTerraformScanFile(name: string): boolean {
  if (name === ".terraform.lock.hcl") return true;
  if (name.startsWith(".")) return false;
  return (
    name.endsWith(".tf") ||
    name.endsWith(".tofu") ||
    name.endsWith(".tf.json") ||
    name.endsWith(".tofu.json") ||
    name.endsWith(".tfvars") ||
    name.endsWith(".tfvars.json")
  );
}

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** A `TreeReader` over a snapshot: its files, and the directories that hold them. */
export function snapshotTreeReader(snapshot: TerraformSnapshot): TreeReader {
  const listing = new Map<string, Map<string, TreeNode>>();
  const bytes = new Map<string, Uint8Array | null>();
  const add = (directory: string, node: TreeNode) => {
    let entries = listing.get(directory);
    if (!entries) {
      entries = new Map();
      listing.set(directory, entries);
    }
    entries.set(node.name, node);
  };
  const encoder = new TextEncoder();
  for (const file of snapshot.files) {
    bytes.set(file.path, file.text === null ? null : encoder.encode(file.text));
    let path = file.path;
    add(dirOf(path), { name: nameOf(path), kind: "file" });
    while (path.includes("/")) {
      path = dirOf(path);
      add(dirOf(path), { name: nameOf(path), kind: "directory" });
    }
  }
  return {
    list: async (path) => [...(listing.get(path)?.values() ?? [])],
    // A file the snapshot did not read is one discovery cannot read either.
    read: async (path) => bytes.get(path) ?? null,
  };
}

export interface ScannedRoot {
  readonly directory: TerraformDirectory;
  /** Directories of local modules it reaches, however many calls away. */
  readonly localModules: readonly string[];
  /** Variables an auto-loaded `.tfvars` in the root sets. */
  readonly tfvarsVariables: readonly string[];
  readonly pricing: ConfigurationPricingInputs;
}

export interface TerraformScanResult {
  /** Every directory holding Terraform files. */
  readonly directories: readonly TerraformDirectory[];
  readonly roots: readonly ScannedRoot[];
  /** The snapshot or discovery stopped at a limit: there may be roots this does not list. */
  readonly truncated: boolean;
}

/** The local modules a root reaches, in the order they are found. */
export function reachableModules(
  root: string,
  directories: ReadonlyMap<string, Pick<TerraformDirectory, "moduleCalls">>,
): string[] {
  const seen = new Set<string>([root]);
  const queue = [root];
  const out: string[] = [];
  while (queue.length > 0) {
    for (const call of directories.get(queue.shift()!)?.moduleCalls ?? []) {
      if (call.localPath === null || seen.has(call.localPath)) continue;
      seen.add(call.localPath);
      if (!directories.has(call.localPath)) continue;
      out.push(call.localPath);
      queue.push(call.localPath);
    }
  }
  return out;
}

/** Scans a snapshot: discovery, then each root's pricing inputs. */
export async function scanTerraformSnapshot(
  snapshot: TerraformSnapshot,
): Promise<TerraformScanResult> {
  const discovery: DiscoveryResult = await discoverTerraformDirectories(
    snapshotTreeReader(snapshot),
  );
  const byPath = new Map(discovery.directories.map((directory) => [directory.path, directory]));

  const filesByDirectory = new Map<string, { name: string; text: string }[]>();
  for (const file of snapshot.files) {
    if (file.text === null) continue;
    const directory = dirOf(file.path);
    const list = filesByDirectory.get(directory) ?? [];
    list.push({ name: nameOf(file.path), text: file.text });
    filesByDirectory.set(directory, list);
  }

  const models = new Map<string, DirectoryModel>();
  const modelOf = (path: string): DirectoryModel => {
    let model = models.get(path);
    if (!model) {
      const files = (filesByDirectory.get(path) ?? [])
        .filter((file) => /\.(tf|tofu)(\.json)?$/.test(file.name))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      model = directoryModel(path, files).model;
      models.set(path, model);
    }
    return model;
  };

  const roots: ScannedRoot[] = [];
  for (const directory of discovery.directories) {
    if (directory.kind !== "root") continue;
    const localModules = reachableModules(directory.path, byPath);
    const scope = new Map<string, DirectoryModel>();
    for (const path of [directory.path, ...localModules]) scope.set(path, modelOf(path));
    const tfvars = new Map<string, HclValue>();
    // In Terraform's order: `terraform.tfvars`, its JSON, then `*.auto.tfvars` by name.
    const variableFiles = (filesByDirectory.get(directory.path) ?? [])
      .filter((file) => isAutoTfvars(file.name))
      .sort((a, b) => {
        const rank = (name: string) => (name.startsWith("terraform.tfvars") ? 0 : 1);
        return rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1);
      });
    for (const file of variableFiles) {
      for (const [name, value] of tfvarsValues(file.name, file.text)) tfvars.set(name, value);
    }
    roots.push({
      directory,
      localModules,
      tfvarsVariables: [...tfvars.keys()].sort(),
      pricing: configurationPricingInputs(directory.path, scope, tfvars),
    });
  }
  return {
    directories: discovery.directories,
    roots,
    truncated: snapshot.truncated || discovery.truncated,
  };
}
