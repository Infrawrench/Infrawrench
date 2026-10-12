import {
  PR_CHECK_LIMITS,
  classifyPrCheckPath,
  type PrCheckPreviewFile,
} from "@infrawrench/client-core";

/**
 * The infrastructure files a working tree changes against `HEAD`, as the
 * before/after pairs `POST /pr-checks/preview` takes: the same input a pull
 * request check reads, built from a local diff instead of a pull request.
 *
 * Git is reached through an injected runner so this is testable without a
 * repository; the extension passes one over `child_process.execFile`.
 */
export interface GitRunner {
  /** Run git with `args` in the repository; resolves stdout, rejects on failure. */
  run(args: string[]): Promise<string>;
  /** Read a working-tree file relative to the repository root; null when absent. */
  readFile(path: string): Promise<string | null>;
}

export interface CollectedDiff {
  files: PrCheckPreviewFile[];
  /** Paths left out, with why (too large, over the file cap). */
  skipped: Array<{ path: string; reason: string }>;
}

/** Parse `git diff --name-status --no-renames -z` output. */
export function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  const parts = out.split("\0").filter((p) => p !== "");
  const rows: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    rows.push({ status: parts[i]!, path: parts[i + 1]! });
  }
  return rows;
}

export async function collectWorkingTreeDiff(
  git: GitRunner,
  /** Unsaved editor contents by repository-relative path; these win over disk. */
  overrides: ReadonlyMap<string, string> = new Map(),
): Promise<CollectedDiff> {
  const tracked = parseNameStatus(
    await git.run(["diff", "--name-status", "--no-renames", "-z", "HEAD", "--"]),
  );
  const untracked = (await git.run(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ status: "A", path }));
  const seen = new Set<string>();
  const candidates = [...tracked, ...untracked];
  for (const path of overrides.keys()) {
    if (!candidates.some((c) => c.path === path)) candidates.push({ status: "M", path });
  }

  const files: PrCheckPreviewFile[] = [];
  const skipped: CollectedDiff["skipped"] = [];
  for (const { status, path } of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    const added = status.startsWith("A");
    const deleted = status.startsWith("D");
    const after = deleted ? null : (overrides.get(path) ?? (await git.readFile(path)));
    if (!classifyPrCheckPath(path, after)) continue;
    const before = added ? null : await git.run(["show", `HEAD:${path}`]).catch(() => null);
    if (before === after) continue;
    const tooBig = [before, after].some(
      (side) => side !== null && Buffer.byteLength(side, "utf8") > PR_CHECK_LIMITS.maxFileBytes,
    );
    if (tooBig) {
      skipped.push({ path, reason: "larger than the preview accepts" });
      continue;
    }
    if (files.length >= PR_CHECK_LIMITS.maxFiles) {
      skipped.push({ path, reason: `over the ${PR_CHECK_LIMITS.maxFiles}-file limit` });
      continue;
    }
    files.push({ path, before, after });
  }
  return { files, skipped };
}
