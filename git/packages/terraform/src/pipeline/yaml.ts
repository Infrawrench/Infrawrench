/**
 * Writing YAML for a pipeline file: maps, lists, scalars and literal blocks,
 * which is all a pipeline uses. Strings are written plain only when no YAML
 * reader could take them for anything else, and as JSON otherwise (a JSON
 * string is a YAML double-quoted scalar).
 */

/** A multi-line string written as a literal block (`|`), for scripts. */
export class Literal {
  constructor(readonly text: string) {}
}

export type YamlValue =
  | string
  | number
  | boolean
  | Literal
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue };

const PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
/** Words YAML 1.1 readers turn into booleans or null. */
const RESERVED = new Set(["true", "false", "yes", "no", "on", "off", "null", "y", "n", "~"]);

function scalar(value: string): string {
  return PLAIN.test(value) && !RESERVED.has(value.toLowerCase()) ? value : JSON.stringify(value);
}

function key(value: string): string {
  // A key is always read as a string by the runner, `on` included.
  return PLAIN.test(value) ? value : JSON.stringify(value);
}

function isMap(value: YamlValue): value is { readonly [key: string]: YamlValue } {
  return typeof value === "object" && !Array.isArray(value) && !(value instanceof Literal);
}

function inline(value: YamlValue): string | null {
  if (typeof value === "string") return scalar(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Literal) return null;
  if (Array.isArray(value)) return value.length === 0 ? "[]" : null;
  return Object.keys(value).length === 0 ? "{}" : null;
}

function write(value: YamlValue, indent: string, out: string[]): void {
  if (value instanceof Literal) {
    for (const line of value.text.replace(/\n+$/, "").split("\n")) {
      out.push(line === "" ? "" : indent + line);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value as readonly YamlValue[]) {
      const flat = inline(item);
      if (flat !== null) out.push(`${indent}- ${flat}`);
      else {
        const nested: string[] = [];
        write(item, `${indent}  `, nested);
        out.push(`${indent}- ${nested[0]!.trimStart()}`, ...nested.slice(1));
      }
    }
    return;
  }
  if (isMap(value)) {
    for (const [name, item] of Object.entries(value)) {
      const flat = inline(item);
      if (flat !== null) out.push(`${indent}${key(name)}: ${flat}`);
      else if (item instanceof Literal) {
        out.push(`${indent}${key(name)}: |`);
        write(item, `${indent}  `, out);
      } else {
        out.push(`${indent}${key(name)}:`);
        write(item, `${indent}  `, out);
      }
    }
  }
}

export function renderYaml(document: { readonly [key: string]: YamlValue }): string {
  const out: string[] = [];
  write(document, "", out);
  return `${out.join("\n")}\n`;
}
