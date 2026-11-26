/**
 * How much Markdown the renderer is given. Its parser and its conversion to
 * elements recurse once per level of nesting and slow down sharply with
 * depth: a comment of twenty thousand `>` overflows the stack, and a few
 * hundred nested list items take seconds. A GFM table pads every row to the
 * header's width, so a short source can ask for millions of cells. Text past
 * these limits is shown as plain text (a table, as its source), so one
 * comment cannot stall or break the page for everyone who opens it.
 */

/** Longer sources are shown as plain text. READMEs are rarely a tenth of this. */
export const MARKDOWN_MAX_LENGTH = 500_000;

/** Deeper nesting (quotes and lists, counted per line) is shown as plain text. */
export const MARKDOWN_MAX_DEPTH = 48;

/** A table with more cells than this, after padding, is shown as its source. */
export const MARKDOWN_MAX_TABLE_CELLS = 20_000;

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
/** After a list marker: a space, a tab, or the end of the line or the text (NaN). */
const isGap = (code: number): boolean =>
  Number.isNaN(code) || code === 32 || code === 9 || code === 10 || code === 13;

/**
 * An upper estimate of how deeply any line nests block containers: each
 * `>` or list marker at the start of the line is a level, and so is every
 * two columns of indentation in front of the first one (a nested list item
 * is indented under its parent). A line with no marker counts nothing,
 * whatever its indentation, so indented code is never mistaken for nesting.
 */
export function containerDepth(source: string): number {
  let deepest = 0;
  let index = 0;
  const length = source.length;
  while (index < length) {
    let indent = 0;
    let markers = 0;
    let seenMarker = false;
    for (;;) {
      const code = source.charCodeAt(index);
      if (code === 32 || code === 9) {
        if (!seenMarker) indent += code === 9 ? 4 - (indent % 4) : 1;
        index++;
      } else if (code === 62 /* > */) {
        markers++;
        seenMarker = true;
        index++;
      } else if (
        (code === 45 || code === 43 || code === 42) /* - + * */ &&
        isGap(source.charCodeAt(index + 1))
      ) {
        markers++;
        seenMarker = true;
        index++;
      } else if (isDigit(code)) {
        let end = index;
        while (end < length && end - index < 9 && isDigit(source.charCodeAt(end))) end++;
        const after = source.charCodeAt(end);
        if ((after === 46 || after === 41) /* . ) */ && isGap(source.charCodeAt(end + 1))) {
          markers++;
          seenMarker = true;
          index = end + 1;
        } else break;
      } else break;
    }
    if (markers > 0) deepest = Math.max(deepest, markers + Math.floor(indent / 2));
    const newline = source.indexOf("\n", index);
    index = newline < 0 ? length : newline + 1;
  }
  return deepest;
}

/** Whether `source` is within what the renderer is given; otherwise show it as text. */
export const withinMarkdownLimits = (source: string): boolean =>
  source.length <= MARKDOWN_MAX_LENGTH && containerDepth(source) <= MARKDOWN_MAX_DEPTH;

/** The part of an mdast node this file reads. */
interface MdNode {
  type: string;
  children?: MdNode[];
  align?: ReadonlyArray<unknown> | null;
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } };
}

const cellsOf = (table: MdNode): number => {
  const rows = table.children ?? [];
  let width = table.align?.length ?? 0;
  for (const row of rows) width = Math.max(width, row.children?.length ?? 0);
  return width * rows.length;
};

/**
 * A remark plugin: every table past `MARKDOWN_MAX_TABLE_CELLS` becomes a code
 * block of its own source text, before the padded cells are ever made.
 */
export function limitTables(source: string) {
  return () => (tree: MdNode) => {
    const stack: MdNode[] = [tree];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const children = node.children;
      if (children === undefined) continue;
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        if (child.type === "table" && cellsOf(child) > MARKDOWN_MAX_TABLE_CELLS) {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const value = start !== undefined && end !== undefined ? source.slice(start, end) : "";
          children[index] = { type: "code", lang: null, meta: null, value } as MdNode;
        } else stack.push(child);
      }
    }
  };
}
