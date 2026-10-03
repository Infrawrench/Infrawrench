/**
 * How a tool card lays out a tool's input, shared by web, desktop and mobile.
 *
 * The card shows the input while an action waits for approval, and the thing
 * being approved is often code: a workflow or graph source, a shell command, a
 * SQL statement. As one JSON string that is a single line of `\n` escapes
 * nobody can review, so top-level multi-line strings are lifted out and shown
 * verbatim under their field name; everything else stays as JSON.
 */
export interface ToolInputPreview {
  /** The input minus the lifted fields; render as JSON. Empty when all were lifted. */
  fields: Record<string, unknown>;
  /** Multi-line string fields, in input order, to render as preformatted text. */
  blocks: Array<{ key: string; text: string }>;
}

export function toolInputPreview(input: Record<string, unknown>): ToolInputPreview {
  const fields: Record<string, unknown> = {};
  const blocks: ToolInputPreview["blocks"] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.includes("\n")) blocks.push({ key, text: value });
    else fields[key] = value;
  }
  return { fields, blocks };
}
