import type { RootReason, TerraformDirectory } from "../roots/discover.js";
import type { ScannedRoot, TerraformScanResult } from "./scan.js";

/**
 * What the Infrastructure tab shows of a detected root: its own declarations
 * and, for counts, those of the local modules it reaches. Plain JSON, kept
 * on the cached scan; no attribute value of any resource is in it.
 */
export interface TerraformRootSummary {
  readonly path: string;
  readonly reasons: readonly RootReason[];
  readonly backend: {
    readonly type: string;
    readonly settings: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  } | null;
  readonly requiredVersion: string | null;
  readonly providers: ReadonlyArray<{
    readonly name: string;
    /** `hashicorp/aws`, when `required_providers` says. */
    readonly source: string | null;
    readonly version: string | null;
    /** It has a `provider` block here. */
    readonly configured: boolean;
    readonly resources: number;
    readonly dataSources: number;
  }>;
  readonly modules: ReadonlyArray<{
    readonly name: string;
    readonly source: string | null;
    readonly version: string | null;
    readonly localPath: string | null;
  }>;
  readonly localModules: readonly string[];
  /** Declared blocks, the root's and its local modules', before `count` and `for_each`. */
  readonly resourceCount: number;
  readonly dataSourceCount: number;
  /** Most first; at most {@link MAX_SUMMARY_TYPES}. */
  readonly resourceTypes: ReadonlyArray<{ readonly type: string; readonly count: number }>;
  readonly variableCount: number;
  /** Variables with no default and no value in an auto-loaded variables file. */
  readonly requiredVariables: readonly string[];
  readonly outputCount: number;
  readonly lockFile: boolean;
  readonly tfvarsFiles: readonly string[];
  readonly usesWorkspace: boolean;
  readonly unreadable: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
  /** Resources and module calls with a `count` or `for_each` of zero with the repository's values. */
  readonly inactiveResources: number;
  readonly inactiveAddresses: readonly string[];
}

export const MAX_SUMMARY_TYPES = 100;

const prefixOf = (type: string): string => {
  const underscore = type.indexOf("_");
  return underscore === -1 ? type : type.slice(0, underscore);
};

/** The summary of one scanned root. `directories` is the whole scan's, by path. */
export function summarizeRoot(
  root: ScannedRoot,
  directories: ReadonlyMap<string, TerraformDirectory>,
): TerraformRootSummary {
  const setByTfvars = new Set(root.tfvarsVariables);
  const own = root.directory;
  const all = [own, ...root.localModules.map((path) => directories.get(path)!).filter(Boolean)];

  const resourceTypes = new Map<string, number>();
  const dataTypes = new Map<string, number>();
  for (const directory of all) {
    for (const [type, count] of Object.entries(directory.resourceTypes)) {
      resourceTypes.set(type, (resourceTypes.get(type) ?? 0) + count);
    }
    for (const [type, count] of Object.entries(directory.dataSourceTypes)) {
      dataTypes.set(type, (dataTypes.get(type) ?? 0) + count);
    }
  }

  const providerNames = new Set<string>([
    ...Object.keys(own.requiredProviders),
    ...own.providers,
    ...[...resourceTypes.keys(), ...dataTypes.keys()].map(prefixOf),
  ]);
  for (const directory of all.slice(1)) {
    for (const name of Object.keys(directory.requiredProviders)) providerNames.add(name);
  }
  const sourceOf = (name: string): string | null => {
    for (const directory of all) {
      const source = directory.requiredProviders[name];
      if (source) return source;
    }
    return null;
  };
  const versionOf = (name: string): string | null => {
    for (const directory of all) {
      const version = directory.providerVersions[name];
      if (version) return version;
    }
    return null;
  };
  const countBy = (types: ReadonlyMap<string, number>, name: string): number => {
    let total = 0;
    for (const [type, count] of types) if (prefixOf(type) === name) total += count;
    return total;
  };
  // A name declared but used by nothing here (`terraform` is built in) is still worth listing.
  const providers = [...providerNames]
    .filter((name) => name !== "terraform")
    .map((name) => ({
      name,
      source: sourceOf(name),
      version: versionOf(name),
      configured: own.providers.includes(name),
      resources: countBy(resourceTypes, name),
      dataSources: countBy(dataTypes, name),
    }))
    .sort((a, b) => b.resources - a.resources || (a.name < b.name ? -1 : 1));

  return {
    path: own.path,
    reasons: own.reasons,
    backend:
      own.backend === null
        ? null
        : {
            type: own.backend,
            settings: Object.entries(own.backendSettings)
              .map(([name, value]) => ({ name, value }))
              .sort((a, b) => (a.name < b.name ? -1 : 1)),
          },
    requiredVersion: own.requiredVersion,
    providers,
    modules: own.moduleCalls.map((call) => ({
      name: call.name,
      source: call.source,
      version: call.version ?? null,
      localPath: call.localPath,
    })),
    localModules: root.localModules,
    resourceCount: all.reduce((sum, directory) => sum + directory.resourceCount, 0),
    dataSourceCount: all.reduce((sum, directory) => sum + directory.dataSourceCount, 0),
    resourceTypes: [...resourceTypes]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1))
      .slice(0, MAX_SUMMARY_TYPES),
    variableCount: own.variables.length,
    requiredVariables: own.variables
      .filter((variable) => variable.required && !setByTfvars.has(variable.name))
      .map((variable) => variable.name),
    outputCount: own.outputCount,
    lockFile: own.lockFile,
    tfvarsFiles: own.tfvarsFiles,
    usesWorkspace: all.some((directory) => directory.usesWorkspace),
    inactiveResources: root.pricing.inactiveCount,
    inactiveAddresses: root.pricing.inactive,
    unreadable: all.flatMap((directory) =>
      directory.unreadable.map((item) => ({
        file: directory.path === "" ? item.file : `${directory.path}/${item.file}`,
        reason: item.reason,
      })),
    ),
  };
}

export interface TerraformScanSummary {
  readonly roots: readonly TerraformRootSummary[];
  /**
   * Every Terraform directory with the local modules it calls: what
   * `rootsTouchedBy` needs to say which roots a change reaches.
   */
  readonly directories: ReadonlyArray<{
    readonly path: string;
    readonly kind: "root" | "module";
    readonly moduleCalls: ReadonlyArray<{ readonly localPath: string | null }>;
  }>;
  /** Directories that are modules (called, or under `modules/`). */
  readonly moduleCount: number;
  readonly truncated: boolean;
}

/** The whole scan as the API keeps it. */
export function summarizeScan(scan: TerraformScanResult): TerraformScanSummary {
  const byPath = new Map(scan.directories.map((directory) => [directory.path, directory]));
  return {
    roots: scan.roots.map((root) => summarizeRoot(root, byPath)),
    directories: scan.directories.map((directory) => ({
      path: directory.path,
      kind: directory.kind,
      moduleCalls: directory.moduleCalls
        .filter((call) => call.localPath !== null)
        .map((call) => ({ localPath: call.localPath })),
    })),
    moduleCount: scan.directories.filter((directory) => directory.kind === "module").length,
    truncated: scan.truncated,
  };
}
