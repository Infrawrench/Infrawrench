/**
 * Emission helpers shared by every target.
 *
 * Each language target owns its own type printing and call printing — that is
 * the part that genuinely differs. What does not differ is the paperwork:
 * every package needs the same license banner, the same "this is generated"
 * warning, and doc comments wrapped to the same width. Nine copies of that
 * paperwork would drift, so it lives here and takes a `CommentStyle`.
 */
import { COPYRIGHT_NOTICE, LICENSE, REPOSITORY_URL } from "./package-metadata";
import type { SdkIr } from "./types";

/**
 * How a language spells comments. `block` is preferred for banners when the
 * language has one; otherwise every line gets the `line` prefix.
 */
export interface CommentStyle {
  /** Prefix for a single-line comment, e.g. `//` or `#`. */
  line: string;
  /** Block comment delimiters, when the language has them. */
  block?: { open: string; prefix: string; close: string };
  /**
   * Documentation comment prefix, when it differs from `line`
   * (`///` in Rust/Swift/C#, `#` in Python where docstrings are used instead).
   */
  doc?: string;
}

export const C_STYLE: CommentStyle = {
  line: "//",
  block: { open: "/*", prefix: " *", close: " */" },
  doc: "///",
};

export const HASH_STYLE: CommentStyle = { line: "#" };

/** Wrap prose to `width` columns without breaking words. */
export function wrap(text: string, width = 78): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

/** Prefix each line with a comment marker, skipping trailing whitespace. */
export function commentLines(lines: string[], marker: string, indent = ""): string[] {
  return lines.map((line) => (line === "" ? `${indent}${marker}` : `${indent}${marker} ${line}`));
}

/**
 * The legal + provenance header that goes at the top of every generated file.
 *
 * The license notice comes first and on its own, so it survives tools that keep
 * only the leading comment; the "do not edit" warning follows.
 */
export function fileBanner(ir: SdkIr, style: CommentStyle, packageName: string): string {
  const legal = [
    `${packageName} v${ir.apiVersion} | ${LICENSE} | ${COPYRIGHT_NOTICE}`,
    REPOSITORY_URL,
  ];
  const provenance = [
    `Generated from the ${ir.title} OpenAPI 3.1 spec (API version ${ir.apiVersion}).`,
    "",
    "DO NOT EDIT. Regenerate with:",
    "  pnpm --filter @infrawrench/web generate:sdk",
    "",
    "Internal routes are absent by construction: the generator consumes the same",
    "published spec that /openapi.json serves, which drops every operation",
    "marked x-internal.",
  ];

  if (style.block) {
    const { open, prefix, close } = style.block;
    return [
      open,
      ...legal.map((line) => `${prefix} ${line}`),
      prefix,
      ...provenance.map((line) => (line === "" ? prefix : `${prefix} ${line}`)),
      close,
      "",
    ].join("\n");
  }
  return [...commentLines([...legal, "", ...provenance], style.line), ""].join("\n");
}

/**
 * A documentation comment for one declaration.
 *
 * Blocks are joined by a blank line and the whole thing is wrapped, so callers
 * can pass a summary, a description, and any number of tag lines without
 * worrying about layout. Returns `null` when there is nothing to say, so
 * callers can skip the line entirely rather than emit an empty comment.
 */
export function docComment(
  parts: Array<string | undefined>,
  style: CommentStyle,
  indent = "",
  width = 78,
): string | null {
  const blocks = parts.filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (blocks.length === 0) return null;
  const lines = wrap(blocks.join("\n\n"), width - indent.length);
  return commentLines(lines, style.doc ?? style.line, indent).join("\n");
}

/**
 * The operation summary, description, route and error list, in the order every
 * target should present them. Targets render the result with their own comment
 * syntax — this only decides *what* is said, so the SDKs read alike.
 */
export function operationDocParts(op: {
  summary?: string | undefined;
  description?: string | undefined;
  method: string;
  path: string;
  deprecated: boolean;
  errors: Array<{ status: string; description?: string | undefined }>;
}): string[] {
  const parts: string[] = [];
  if (op.summary) parts.push(op.summary);
  if (op.description) parts.push(op.description);
  parts.push(`${op.method.toUpperCase()} ${op.path}`);
  if (op.deprecated) parts.push("Deprecated.");
  for (const error of op.errors) {
    parts.push(`Raises on ${error.status}: ${error.description ?? "Error"}`);
  }
  return parts;
}
