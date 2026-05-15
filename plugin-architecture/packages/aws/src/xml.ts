/**
 * XML parsing for AWS Query/REST-XML responses.
 *
 * Replaces the DOMParser-based parser from the old `auth.ts`. DOMParser is
 * not available in pure-Node contexts (Electron renderer worked, but the
 * desktop main process / server runtime did not). `fast-xml-parser` is a
 * transitive dep of `@aws-sdk/client-*` packages and is also imported by
 * the SDK's own XML protocol layer, so this is purely zero-cost reuse.
 *
 * Output shape is intentionally compatible with the previous parser:
 *   - `<foo>bar</foo>` → `{ foo: "bar" }`
 *   - Repeated `<item>` / `<member>` children collapse into an array under
 *     their parent key. The historical listers index that array as either a
 *     direct `string[]` or `Record<string, unknown>[]`, so we honour that.
 */

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Strip the `<?xml ?>` declaration so it does not show up as a `?xml` key
  // alongside the response root. Without this, AWS XML responses that include
  // the declaration (e.g. EC2 `RunInstances`) parse to two top-level keys and
  // the root-unwrap below bails out, leaving callers reading from the wrong
  // level of the tree.
  ignoreDeclaration: true,
  isArray: (tagName) => tagName === "item" || tagName === "member",
});

export function parseXml(xml: string): Record<string, unknown> {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  // AWS XML responses always have a single root element (e.g.
  // DescribeInstancesResponse); the existing call sites expect the body of
  // that root, not the root itself.
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return parsed;
  const inner = parsed[keys[0]!];
  if (inner == null || typeof inner !== "object") return parsed;
  return inner as Record<string, unknown>;
}

/**
 * AWS Query XML wraps lists as `<container><item>…</item><item>…</item></container>`.
 * `fast-xml-parser` already collapses `item`/`member` into arrays, but the
 * legacy parser had a quirk where a single-element list became the value
 * directly rather than a one-element array. `ensureArray` normalises that.
 */
export function ensureArray<T>(val: T | T[] | undefined | null): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}
