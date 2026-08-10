/**
 * Fan-out SSH — shared, platform-neutral logic for running one command across
 * many hosts and making the odd one out obvious.
 *
 * Pure functions only: output grouping (collapse identical results), line
 * diffing (how an outlier differs from the majority), and a small concurrency
 * limiter used by the runners on web, desktop, and the CLI.
 */

/** Per-host lifecycle state of a fan-out run. */
export type FanoutHostStatus = "pending" | "running" | "done" | "error" | "blocked";

/** One host's result within a fan-out run. */
export interface FanoutHostResult {
  /** Resource id (or account id for direct SSH hosts). */
  targetId: string;
  /** Human-readable host label (resource display name / host). */
  label: string;
  status: FanoutHostStatus;
  /** Exit code of the remote command; null when it never ran. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Transport / policy error (connection refused, host key untrusted, freeze…). */
  error?: string;
  durationMs?: number;
}

/** A set of hosts that produced byte-identical (normalized) output. */
export interface FanoutOutputGroup {
  /** Stable grouping key — normalized output + exit code (or error class). */
  key: string;
  results: FanoutHostResult[];
  /** Representative output shown for the collapsed group. */
  output: string;
  exitCode: number | null;
  /** True for the largest group — the "expected" output the rest diff against. */
  isMajority: boolean;
  /** True when every host in the group failed to run (transport/policy error). */
  isFailure: boolean;
}

/**
 * Normalize command output for grouping: strip trailing whitespace per line
 * and trailing blank lines so cosmetic differences don't split groups.
 */
export function normalizeFanoutOutput(stdout: string, stderr: string): string {
  const combined = stderr.trim().length > 0 && stdout.trim().length === 0 ? stderr : stdout;
  return combined
    .split("\n")
    .map((l) => l.replace(/[ \t\r]+$/u, ""))
    .join("\n")
    .replace(/\n+$/u, "");
}

/**
 * Collapse per-host results into groups of identical output, largest first.
 * The largest successful group is flagged as the majority; every other group
 * is an outlier the UI diffs against it.
 */
export function groupFanoutResults(results: FanoutHostResult[]): FanoutOutputGroup[] {
  const byKey = new Map<string, FanoutOutputGroup>();
  for (const r of results) {
    if (r.status === "pending" || r.status === "running") continue;
    const failed = r.status === "error" || r.status === "blocked";
    const output = failed && r.error ? r.error : normalizeFanoutOutput(r.stdout, r.stderr);
    const key = failed ? `err:${r.status}:${output}` : `ok:${r.exitCode ?? 0}:${output}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        results: [],
        output,
        exitCode: r.exitCode,
        isMajority: false,
        isFailure: failed,
      };
      byKey.set(key, group);
    }
    group.results.push(r);
  }
  const groups = [...byKey.values()].sort((a, b) => {
    // Successful groups before failure groups, then by size, then stable by key.
    if (a.isFailure !== b.isFailure) return a.isFailure ? 1 : -1;
    if (b.results.length !== a.results.length) return b.results.length - a.results.length;
    return a.key < b.key ? -1 : 1;
  });
  const majority = groups.find((g) => !g.isFailure) ?? groups[0];
  if (majority) majority.isMajority = true;
  return groups;
}

/** One line of a computed diff. */
export interface DiffLine {
  type: "same" | "added" | "removed";
  line: string;
}

/**
 * Line-based diff between the majority output (`base`) and an outlier
 * (`other`), via longest-common-subsequence. "added" lines exist only in the
 * outlier; "removed" lines exist only in the majority output.
 */
export function diffLines(base: string, other: string): DiffLine[] {
  const a = base === "" ? [] : base.split("\n");
  const b = other === "" ? [] : other.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS table (n+1 x m+1). Outputs are capped upstream, so O(n*m) is fine.
  const lcs: number[] = new Array((n + 1) * (m + 1)).fill(0);
  const at = (i: number, j: number) => lcs[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", line: a[i] ?? "" });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ type: "removed", line: a[i] ?? "" });
      i++;
    } else {
      out.push({ type: "added", line: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) out.push({ type: "removed", line: a[i++] ?? "" });
  while (j < m) out.push({ type: "added", line: b[j++] ?? "" });
  return out;
}

/**
 * Collapse long runs of unchanged lines in a diff to `context` lines around
 * each change, inserting `{type:"same", line:"⋯ N unchanged lines ⋯"}`-style
 * separators. Returns the diff untouched when nothing can be collapsed.
 */
export function compactDiff(lines: DiffLine[], context = 2): (DiffLine | { skipped: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.type !== "same") {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  }
  const out: (DiffLine | { skipped: number })[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ skipped });
        skipped = 0;
      }
      out.push(lines[i] as DiffLine);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push({ skipped });
  return out;
}

/** Default cap on simultaneous SSH connections during a fan-out run. */
export const FANOUT_DEFAULT_CONCURRENCY = 8;

/** Hard ceiling on hosts per fan-out run. */
export const FANOUT_MAX_TARGETS = 100;

/**
 * Run `fn` over `items` with at most `limit` in flight. Results keep input
 * order. Rejections are not swallowed — callers wrap `fn` to capture errors
 * per item.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
