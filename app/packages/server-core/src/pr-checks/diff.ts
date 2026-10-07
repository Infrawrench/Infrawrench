/**
 * The pure half of a pull request check: which files are infrastructure, and
 * which Terraform resource blocks the change adds, edits or removes.
 *
 * Blocks are compared per **directory** (a Terraform module), not per file,
 * because Terraform addresses are unique within a module and moving a block
 * between two files of the same module changes nothing Terraform will plan.
 * A `moved` block on the new side turns the matching remove-plus-add into an
 * edit of the renamed resource.
 */
import {
  PR_CHECK_LIMITS,
  classifyPrCheckPath,
  pathInPrCheckDirectories,
  type PrCheckChangeAction,
  type PrCheckFile,
  type PrCheckFileKind,
} from "@infrawrench/client-core";

import {
  changedAttributes,
  parseHclFile,
  type HclMove,
  type HclResourceBlock,
} from "./hcl-blocks.js";

/** One changed file, with its text on both sides (null = absent). */
export interface PrCheckSourceFile {
  path: string;
  /** The path on the base side when the file was renamed. */
  previousPath?: string | null;
  before: string | null;
  after: string | null;
}

export interface BlockChange {
  action: PrCheckChangeAction;
  address: string;
  terraformType: string;
  directory: string;
  path: string;
  line: number | null;
  before: HclResourceBlock | null;
  after: HclResourceBlock | null;
  changedAttributes: string[];
  /** Set when a `moved` block renamed it: the address on the base side. */
  movedFrom: string | null;
}

export interface TerraformDiff {
  files: PrCheckFile[];
  changes: BlockChange[];
  /** One sentence per thing the diff saw but could not read. */
  notes: string[];
  parseErrors: Array<{ path: string; message: string }>;
  truncated: boolean;
}

function directoryOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function fileStatus(f: PrCheckSourceFile): PrCheckFile["status"] {
  if (f.before === null) return "added";
  if (f.after === null) return "removed";
  if (f.previousPath && f.previousPath !== f.path) return "renamed";
  return "modified";
}

const NOT_ANALYSED: Record<Exclude<PrCheckFileKind, "terraform">, string> = {
  infrafile:
    "An Infrafile is a program: the check does not run code from a pull request. Run `infrawrench deploy --plan` to see what it would change.",
  kubernetes:
    "Kubernetes manifests are listed but not priced; workload cost is allocated from the cluster's nodes after it runs.",
};

/** Upper bound on blocks compared per check; past it the report says truncated. */
export const MAX_BLOCK_CHANGES = 200;

/**
 * Classify the files and diff the Terraform ones. `directories` scopes the
 * check to path prefixes (empty = everywhere).
 */
export function diffInfrastructureFiles(
  input: readonly PrCheckSourceFile[],
  directories: readonly string[] = [],
): TerraformDiff {
  const files: PrCheckFile[] = [];
  const notes: string[] = [];
  const parseErrors: TerraformDiff["parseErrors"] = [];
  let truncated = false;

  // directory → address → block, per side.
  const before = new Map<string, Map<string, { block: HclResourceBlock; path: string }>>();
  const after = new Map<string, Map<string, { block: HclResourceBlock; path: string }>>();
  const moves = new Map<string, HclMove[]>();
  const modules = new Set<string>();

  const relevant = input.filter((f) => {
    const kind = classifyPrCheckPath(f.path, f.after ?? f.before);
    return kind !== null && pathInPrCheckDirectories(f.path, directories);
  });
  if (relevant.length > PR_CHECK_LIMITS.maxFiles) {
    truncated = true;
    notes.push(
      `Only the first ${PR_CHECK_LIMITS.maxFiles} of ${relevant.length} infrastructure files were analysed.`,
    );
  }

  for (const f of relevant.slice(0, PR_CHECK_LIMITS.maxFiles)) {
    const kind = classifyPrCheckPath(f.path, f.after ?? f.before)!;
    if (kind !== "terraform") {
      files.push({ path: f.path, kind, status: fileStatus(f), analysed: false, note: NOT_ANALYSED[kind] });
      continue;
    }
    files.push({ path: f.path, kind, status: fileStatus(f), analysed: true, note: null });
    const sides: Array<[string | null, string, typeof before]> = [
      [f.before, f.previousPath ?? f.path, before],
      [f.after, f.path, after],
    ];
    for (const [text, path, into] of sides) {
      if (text === null) continue;
      const parsed = parseHclFile(text);
      const dir = directoryOf(path);
      for (const message of parsed.errors) parseErrors.push({ path, message });
      for (const mod of parsed.modules) modules.add(`${path}: module "${mod.name}"`);
      let bucket = into.get(dir);
      if (!bucket) {
        bucket = new Map();
        into.set(dir, bucket);
      }
      for (const block of parsed.resources) bucket.set(block.address, { block, path });
      if (into === after && parsed.moves.length > 0) {
        moves.set(dir, [...(moves.get(dir) ?? []), ...parsed.moves]);
      }
    }
  }

  const changes: BlockChange[] = [];
  const dirs = new Set([...before.keys(), ...after.keys()]);
  for (const dir of [...dirs].sort()) {
    const a = before.get(dir) ?? new Map();
    const b = after.get(dir) ?? new Map();
    const renamedTo = new Map<string, string>();
    for (const move of moves.get(dir) ?? []) {
      if (a.has(move.from) && !b.has(move.from) && b.has(move.to) && !a.has(move.to)) {
        renamedTo.set(move.from, move.to);
      }
    }
    const renamedFrom = new Map([...renamedTo].map(([from, to]) => [to, from]));

    for (const [address, side] of b) {
      const priorAddress = renamedFrom.get(address) ?? address;
      const prior = a.get(priorAddress);
      if (!prior) {
        changes.push({
          action: "create",
          address,
          terraformType: side.block.type,
          directory: dir,
          path: side.path,
          line: side.block.line,
          before: null,
          after: side.block,
          changedAttributes: [],
          movedFrom: null,
        });
        continue;
      }
      const changed = changedAttributes(prior.block, side.block);
      if (changed.length === 0 && priorAddress === address) continue;
      changes.push({
        action: "update",
        address,
        terraformType: side.block.type,
        directory: dir,
        path: side.path,
        line: side.block.line,
        before: prior.block,
        after: side.block,
        changedAttributes: changed,
        movedFrom: priorAddress === address ? null : priorAddress,
      });
    }
    for (const [address, side] of a) {
      if (b.has(address) || renamedTo.has(address)) continue;
      changes.push({
        action: "delete",
        address,
        terraformType: side.block.type,
        directory: dir,
        path: side.path,
        line: null,
        before: side.block,
        after: null,
        changedAttributes: [],
        movedFrom: null,
      });
    }
  }

  if (modules.size > 0) {
    notes.push(
      `Module calls are not expanded, so resources declared inside modules are not covered (${[...modules].slice(0, 3).join(", ")}${modules.size > 3 ? ", …" : ""}).`,
    );
  }
  if (changes.length > MAX_BLOCK_CHANGES) {
    truncated = true;
    notes.push(`Only the first ${MAX_BLOCK_CHANGES} of ${changes.length} changed blocks were analysed.`);
  }

  return {
    files,
    changes: changes.slice(0, MAX_BLOCK_CHANGES),
    notes,
    parseErrors,
    truncated,
  };
}
