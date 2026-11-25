/**
 * Line anchors of a file view: `#L10` and `#L10-L20`.
 */

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The range a URL hash names, or null. Accepts `#L5`, `#L5-L9` and `#L5-9`; ends in either order. */
export function parseLineHash(hash: string): LineRange | null {
  const match = /^#?L(\d+)(?:-L?(\d+))?$/.exec(hash);
  if (!match) return null;
  const a = Number(match[1]);
  const b = match[2] === undefined ? a : Number(match[2]);
  if (a < 1 || b < 1) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** `L10` or `L10-L20`, without the `#`. */
export function formatLineHash(range: LineRange): string {
  return range.start === range.end ? `L${range.start}` : `L${range.start}-L${range.end}`;
}

/**
 * The selection after a click on line `line`. A plain click selects that
 * line (or clears it when it was the whole selection); a shift-click extends
 * from the selection's anchor, its start, to the clicked line.
 */
export function selectLine(
  current: LineRange | null,
  line: number,
  extend: boolean,
): LineRange | null {
  if (extend && current !== null) {
    const anchor = line < current.start ? current.end : current.start;
    return { start: Math.min(anchor, line), end: Math.max(anchor, line) };
  }
  if (current !== null && current.start === line && current.end === line) return null;
  return { start: line, end: line };
}

export const inRange = (range: LineRange | null, line: number): boolean =>
  range !== null && line >= range.start && line <= range.end;
