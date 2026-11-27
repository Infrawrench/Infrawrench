/**
 * The focused view of a file's diff: only the lines something is about, with
 * a few around each, and what is left out counted. Also what the page
 * remembers about each file while it is open (shown or not, in full or not,
 * what the reader asked to see), and the order the files go in. Pure
 * functions, no renderer in them; `patchOf` turns the hunks made here into
 * what the renderer reads.
 */
import type { DiffFile, DiffHunk, DiffLine } from "@infrawrench/git-contract";

/** Lines of one side of a file, first to last. */
export interface FocusRange {
  readonly side: "additions" | "deletions";
  readonly start: number;
  readonly end: number;
}

/** Lines shown around what a file's diff is focused on. */
export const FOCUS_CONTEXT = 3;

/**
 * One row of a diff as a side-by-side view pairs it: a line both sides have,
 * or the nth removed line of a change beside its nth added one. Windows are
 * cut between these rows, never inside one, so a removed line stays beside
 * the line that replaced it however the window is drawn.
 */
interface Unit {
  /** The change this row is in, or `-1` for a line both sides have. */
  readonly block: number;
  readonly context?: DiffLine;
  readonly del?: DiffLine;
  readonly add?: DiffLine;
  /** The old and new files' next line numbers when this row starts. */
  readonly oldAt: number;
  readonly newAt: number;
}

function unitsOf(hunk: DiffHunk): Unit[] {
  const units: Unit[] = [];
  // A hunk with no lines on a side names the line before it.
  let oldAt = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newAt = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  let block = 0;
  const lines = hunk.lines;
  for (let at = 0; at < lines.length;) {
    const line = lines[at]!;
    if (line.type === "context") {
      units.push({ block: -1, context: line, oldAt, newAt });
      oldAt++;
      newAt++;
      at++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[at]?.type === "delete") dels.push(lines[at++]!);
    while (lines[at]?.type === "add") adds.push(lines[at++]!);
    for (let row = 0; row < Math.max(dels.length, adds.length); row++) {
      const del = dels[row];
      const add = adds[row];
      units.push({
        block,
        ...(del === undefined ? {} : { del }),
        ...(add === undefined ? {} : { add }),
        oldAt: oldAt + Math.min(row, dels.length),
        newAt: newAt + Math.min(row, adds.length),
      });
    }
    oldAt += dels.length;
    newAt += adds.length;
    block++;
  }
  return units;
}

const within = (line: number | null | undefined, range: FocusRange): boolean =>
  line !== null && line !== undefined && line >= range.start && line <= range.end;

const touches = (unit: Unit, range: FocusRange): boolean =>
  range.side === "deletions"
    ? within(unit.del?.oldLine, range) || within(unit.context?.oldLine, range)
    : within(unit.add?.newLine, range) || within(unit.context?.newLine, range);

const changedIn = (unit: Unit): number =>
  (unit.del === undefined ? 0 : 1) + (unit.add === undefined ? 0 : 1);

/** A run of rows as a hunk of its own, numbered where it starts. */
function hunkOf(section: string, units: ReadonlyArray<Unit>): DiffHunk {
  const lines: DiffLine[] = [];
  for (let at = 0; at < units.length;) {
    const unit = units[at]!;
    if (unit.context !== undefined) {
      lines.push(unit.context);
      at++;
      continue;
    }
    // A change's rows: its removed lines, then its added ones.
    let end = at;
    while (end < units.length && units[end]!.block === unit.block) end++;
    for (let row = at; row < end; row++) {
      const del = units[row]!.del;
      if (del !== undefined) lines.push(del);
    }
    for (let row = at; row < end; row++) {
      const add = units[row]!.add;
      if (add !== undefined) lines.push(add);
    }
    at = end;
  }
  const oldLines = lines.filter((line) => line.type !== "add").length;
  const newLines = lines.filter((line) => line.type !== "delete").length;
  const first = units[0]!;
  return {
    oldStart: oldLines === 0 ? first.oldAt - 1 : first.oldAt,
    oldLines,
    newStart: newLines === 0 ? first.newAt - 1 : first.newAt,
    newLines,
    section,
    lines,
  };
}

/** Lines of the diff drawn together: hunks with only unchanged lines left out between them. */
export interface FocusLines {
  readonly kind: "lines";
  readonly key: string;
  readonly hunks: ReadonlyArray<DiffHunk>;
}

/** Changed lines left out between what is drawn. */
export interface FocusGap {
  readonly kind: "gap";
  readonly key: string;
  /** Added and removed lines not shown here. */
  readonly changed: number;
  /** What showing them adds to the file's focus. */
  readonly reveal: ReadonlyArray<FocusRange>;
}

export interface FocusedFile {
  readonly pieces: ReadonlyArray<FocusLines | FocusGap>;
  readonly shownChanged: number;
  readonly totalChanged: number;
}

/**
 * A file's diff cut down to the rows `focus` names and `context` rows around
 * each. Rows left out with a change among them become a gap that says how
 * many changed lines it holds; rows left out with none are simply not drawn,
 * as between any two hunks. Null when nothing changed would be left out, or
 * nothing is in focus: the whole diff is then the thing to draw.
 */
export function focusFile(
  file: DiffFile,
  focus: ReadonlyArray<FocusRange>,
  context: number = FOCUS_CONTEXT,
): FocusedFile | null {
  if (focus.length === 0) return null;
  const pieces: (FocusLines | FocusGap)[] = [];
  let run: DiffHunk[] = [];
  let hidden: Unit[] = [];
  let shownChanged = 0;
  let totalChanged = 0;
  let any = false;

  const closeGap = (): void => {
    const changed = hidden.reduce((total, unit) => total + changedIn(unit), 0);
    if (changed > 0) {
      if (run.length > 0) {
        pieces.push({ kind: "lines", key: `lines:${keyOfHunk(run[0]!)}`, hunks: run });
        run = [];
      }
      pieces.push({
        kind: "gap",
        key: `gap:${hidden[0]!.oldAt}:${hidden[0]!.newAt}`,
        changed,
        reveal: revealOf(hidden),
      });
    }
    hidden = [];
  };

  for (const hunk of file.hunks) {
    const units = unitsOf(hunk);
    const shown = new Array<boolean>(units.length).fill(false);
    for (const range of focus) {
      for (const [at, unit] of units.entries()) {
        if (!touches(unit, range)) continue;
        const from = Math.max(0, at - context);
        const to = Math.min(units.length - 1, at + context);
        for (let row = from; row <= to; row++) shown[row] = true;
      }
    }
    for (let at = 0; at < units.length;) {
      if (!shown[at]) {
        hidden.push(units[at]!);
        totalChanged += changedIn(units[at]!);
        at++;
        continue;
      }
      let end = at;
      while (end < units.length && shown[end]) end++;
      closeGap();
      const part = units.slice(at, end);
      const changed = part.reduce((total, unit) => total + changedIn(unit), 0);
      shownChanged += changed;
      totalChanged += changed;
      run.push(hunkOf(hunk.section, part));
      any = true;
      at = end;
    }
  }
  closeGap();
  if (run.length > 0)
    pieces.push({ kind: "lines", key: `lines:${keyOfHunk(run[0]!)}`, hunks: run });
  if (!any || shownChanged === totalChanged) return null;
  return { pieces, shownChanged, totalChanged };
}

const keyOfHunk = (hunk: DiffHunk): string => `${hunk.oldStart}:${hunk.newStart}`;

function revealOf(units: ReadonlyArray<Unit>): FocusRange[] {
  const span = (side: FocusRange["side"], lines: ReadonlyArray<number>): FocusRange[] =>
    lines.length === 0 ? [] : [{ side, start: Math.min(...lines), end: Math.max(...lines) }];
  const old: number[] = [];
  const next: number[] = [];
  for (const unit of units) {
    if (unit.del !== undefined && unit.del.oldLine !== null) old.push(unit.del.oldLine);
    if (unit.add !== undefined && unit.add.newLine !== null) next.push(unit.add.newLine);
  }
  return [...span("deletions", old), ...span("additions", next)];
}

/** Rows a card shows of the lines it is about, at most. */
export const EXCERPT_ROWS = 12;

/**
 * The few lines a card shows beside its text: the lines it is about, as the
 * diff has them, with one line either side. Empty when the diff does not
 * show them.
 */
export function excerptOf(file: DiffFile, range: FocusRange): DiffHunk[] {
  const capped = { ...range, end: Math.min(range.end, range.start + EXCERPT_ROWS - 1) };
  const hunks: DiffHunk[] = [];
  for (const hunk of file.hunks) {
    const units = unitsOf(hunk);
    let first = -1;
    let last = -1;
    for (const [at, unit] of units.entries()) {
      if (!touches(unit, capped)) continue;
      if (first === -1) first = at;
      last = at;
    }
    if (first === -1) continue;
    hunks.push(
      hunkOf(hunk.section, units.slice(Math.max(0, first - 1), Math.min(units.length, last + 2))),
    );
  }
  return hunks;
}

/** The lines a set of hunks draws, as the keys annotations are hung by. */
export function linesOfHunks(hunks: ReadonlyArray<DiffHunk>): Set<string> {
  const keys = new Set<string>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "delete") {
        if (line.oldLine !== null) keys.add(`deletions:${line.oldLine}`);
      } else if (line.newLine !== null) keys.add(`additions:${line.newLine}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// What the page remembers about each file while it is open
// ---------------------------------------------------------------------------

export interface FileView {
  /** Its diff is drawn, not only its header. */
  readonly open: boolean;
  /** The whole diff, not only what is in focus. */
  readonly full: boolean;
  /** Lines the reader asked to see beyond what is in focus. */
  readonly reveals: ReadonlyArray<FocusRange>;
}

export interface DiffViewState {
  /** What "Expand all" or "Collapse all" last said, for files not touched since. */
  readonly all: boolean | null;
  readonly files: ReadonlyMap<string, Partial<FileView>>;
}

export const EMPTY_VIEW: DiffViewState = { all: null, files: new Map() };

const NO_REVEALS: ReadonlyArray<FocusRange> = [];

/** A file starts as its header alone. */
export function fileView(state: DiffViewState, path: string): FileView {
  const own = state.files.get(path);
  return {
    open: own?.open ?? state.all ?? false,
    full: own?.full ?? false,
    reveals: own?.reveals ?? NO_REVEALS,
  };
}

const withFile = (state: DiffViewState, path: string, change: Partial<FileView>): DiffViewState => {
  const files = new Map(state.files);
  files.set(path, { ...files.get(path), ...change });
  return { ...state, files };
};

export const setOpen = (state: DiffViewState, path: string, open: boolean): DiffViewState =>
  withFile(state, path, { open });

export const setFull = (state: DiffViewState, path: string, full: boolean): DiffViewState =>
  withFile(state, path, { open: true, full });

/** Show these lines of a file, opening it. */
export function reveal(
  state: DiffViewState,
  path: string,
  ranges: ReadonlyArray<FocusRange>,
): DiffViewState {
  const before = fileView(state, path).reveals;
  const added = ranges.filter(
    (range) =>
      !before.some(
        (other) =>
          other.side === range.side && other.start <= range.start && other.end >= range.end,
      ),
  );
  return withFile(state, path, {
    open: true,
    ...(added.length === 0 ? {} : { reveals: [...before, ...added] }),
  });
}

/** Every file shown or every file closed; what was revealed in each is kept. */
export function setAll(state: DiffViewState, open: boolean): DiffViewState {
  const files = new Map<string, Partial<FileView>>();
  for (const [path, view] of state.files) {
    const { open: _open, ...rest } = view;
    files.set(path, rest);
  }
  return { all: open, files };
}

// ---------------------------------------------------------------------------
// The order of the files
// ---------------------------------------------------------------------------

export interface FileNotes {
  /** Files with an open must-fix finding. */
  readonly mustFix: ReadonlySet<string>;
  /** Files the trace names, each with where the trace first names it. */
  readonly traced: ReadonlyMap<string, number>;
  /** Files with anything else on them: a finding, a review thread. */
  readonly noted: ReadonlySet<string>;
}

/** `0` must fix, `1` in the trace, `2` otherwise noted, `3` nothing on it. */
export function rankOf(path: string, notes: FileNotes): number {
  if (notes.mustFix.has(path)) return 0;
  if (notes.traced.has(path)) return 1;
  if (notes.noted.has(path)) return 2;
  return 3;
}

/**
 * The files in the order a reader should meet them: what must be fixed, then
 * the files of the trace in the order the agent went through them, then
 * whatever else has something on it, then the rest by path. `held` keeps a
 * file where it was while the reader is writing on it.
 */
export function orderFiles<T extends { readonly path: string }>(
  files: ReadonlyArray<T>,
  notes: FileNotes,
  held: ReadonlyMap<string, number> = new Map(),
): T[] {
  const rank = (path: string) => held.get(path) ?? rankOf(path, notes);
  const step = (path: string) => notes.traced.get(path) ?? Number.MAX_SAFE_INTEGER;
  return [...files].sort(
    (a, b) =>
      rank(a.path) - rank(b.path) ||
      (rank(a.path) <= 1 ? step(a.path) - step(b.path) : 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
