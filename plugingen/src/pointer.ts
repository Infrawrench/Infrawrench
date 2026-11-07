import { isObject, type JsonObject, type JsonValue } from "./json.js";

export function decodeSegment(segment: string): string {
  return decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Own properties only: `#/components/schemas/constructor` must not find `Object`. */
export function child(node: JsonValue | undefined, key: string): JsonValue | undefined {
  if (Array.isArray(node)) {
    const index = Number(key);
    return Number.isInteger(index) ? node[index] : undefined;
  }
  return isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
}

/** Read a `#/...` pointer, percent-encoded or not, through any `$ref` on the way. */
export function resolvePointer(doc: JsonObject, ref: string): JsonValue | undefined {
  if (ref === "#") return doc;
  let cur: JsonValue | undefined = doc;
  for (const segment of ref.slice(2).split("/")) {
    if (isObject(cur)) {
      const inner: JsonValue | undefined = cur["$ref"];
      if (typeof inner === "string" && inner.startsWith("#/")) cur = resolvePointer(doc, inner);
    }
    cur = child(cur, decodeSegment(segment));
  }
  return cur;
}
