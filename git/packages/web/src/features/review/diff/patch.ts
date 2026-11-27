/**
 * The arithmetic between the API's diff (`DiffFile`: hunks of numbered lines)
 * and the diff renderer, which reads a patch: the file as patch text, the old
 * file's text worked back from the new one, and the line an annotation that
 * belongs above a line is hung under. Pure functions, no renderer in them.
 */
import type { DiffFile, DiffHunk } from "@infrawrench/git-contract";
import { showBidi } from "../../../lib/bidi";

const range = (start: number, count: number): string =>
  count === 1 ? String(start) : `${start},${count}`;

/** What a path is in a patch header. A newline in a name would end the header. */
const headerPath = (path: string): string => showBidi(path).replace(/[\r\n\t]/g, " ");

/**
 * A line as the patch carries it: bidirectional controls written out as the
 * rest of the site writes them, and no carriage return for the parser to
 * split on.
 */
export const patchLine = (content: string): string => showBidi(content).replace(/\r/g, "");

/** One file's hunks as a patch, the way Git prints them. */
export function patchOf(file: DiffFile): string {
  const oldPath = headerPath(file.oldPath ?? file.path);
  const newPath = headerPath(file.path);
  const out = [`diff --git a/${oldPath} b/${newPath}`];
  if (file.status === "added") out.push(`new file mode ${file.newMode ?? "100644"}`);
  if (file.status === "deleted") out.push(`deleted file mode ${file.oldMode ?? "100644"}`);
  if (file.status === "renamed" && file.oldPath !== null) {
    // The parser reads a rename off this line; the number itself is not shown.
    const similarity = file.similarity ?? (file.hunks.length === 0 ? 100 : 50);
    out.push(`similarity index ${similarity}%`, `rename from ${oldPath}`, `rename to ${newPath}`);
  }
  out.push(file.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`);
  out.push(file.status === "deleted" ? "+++ /dev/null" : `+++ b/${newPath}`);
  for (const hunk of file.hunks) {
    const section = hunk.section === "" ? "" : ` ${patchLine(hunk.section)}`;
    out.push(
      `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@${section}`,
    );
    for (const line of hunk.lines) {
      const sign = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
      out.push(`${sign}${patchLine(line.content)}`);
      if (line.noNewlineAtEnd === true) out.push("\\ No newline at end of file");
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * The old file's lines, from the new file's and the hunks between them: what
 * the hunks do not cover is the same on both sides, and what they cover is in
 * them. One request for the new file is then enough to show hidden lines.
 */
export function oldLinesOf(
  newLines: ReadonlyArray<string>,
  hunks: ReadonlyArray<DiffHunk>,
): string[] {
  const old: string[] = [];
  // The next line of the new file not yet carried over, 1-based.
  let next = 1;
  for (const hunk of hunks) {
    // A hunk with no new lines names the line before it.
    const first = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    for (; next < first; next++) old.push(newLines[next - 1] ?? "");
    for (const line of hunk.lines) if (line.type !== "add") old.push(line.content);
    next = first + hunk.newLines;
  }
  for (; next <= newLines.length; next++) old.push(newLines[next - 1] ?? "");
  return old;
}

export interface RowAnchor {
  readonly side: "additions" | "deletions";
  /** `0` is above the file's first line. */
  readonly lineNumber: number;
}

/**
 * The renderer draws an annotation under a line. For one that belongs above
 * line `newLine` of the new file, this is the line to hang it under: the row
 * before it. In a split diff the removed lines sit beside the added ones, so
 * the row before a change's first added line is the one before the removals.
 * A hunk that opens on the line has no row before it: above the file's first
 * hunk is above the file, and anywhere else it stays under its own line.
 * Null when the diff does not show the line.
 */
export function rowAbove(
  file: DiffFile,
  newLine: number,
  layout: "unified" | "split",
): RowAnchor | null {
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const at = hunk.lines.findIndex((line) => line.type !== "delete" && line.newLine === newLine);
    if (at === -1) continue;
    let before = at - 1;
    if (layout === "split" && hunk.lines[at]!.type === "add") {
      while (before >= 0 && hunk.lines[before]!.type === "delete") before--;
    }
    const previous = hunk.lines[before];
    if (previous === undefined) {
      return { side: "additions", lineNumber: hunkIndex === 0 ? 0 : newLine };
    }
    if (previous.type === "delete") {
      return previous.oldLine === null ? null : { side: "deletions", lineNumber: previous.oldLine };
    }
    return previous.newLine === null ? null : { side: "additions", lineNumber: previous.newLine };
  }
  return null;
}
