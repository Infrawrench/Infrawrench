import { PluginGenError } from "./errors.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** `undefined` because the Swagger 2 upgrader leaves keys set to it. */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one place a parsed document stops being `unknown`.
 *
 * Documents are untrusted, so this also refuses what the pipeline must not walk: a
 * `__proto__` key, which plain assignment would turn into a prototype, and a cycle,
 * which a YAML alias can write and which nothing below terminates on.
 */
export function assertJsonObject(value: unknown, what: string): asserts value is JsonObject {
  const finished = new WeakSet<object>();
  const active = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    const type = typeof node;
    if (type === "string" || type === "number" || type === "boolean") return;
    if (type !== "object") throw new PluginGenError("parse", `${what} holds a ${type}`);
    const container: object = Object(node);
    if (finished.has(container)) return;
    if (active.has(container)) throw new PluginGenError("unsafe", `${what} refers to itself`);
    active.add(container);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else {
      for (const [key, child] of Object.entries(container)) {
        if (key === "__proto__") {
          throw new PluginGenError("unsafe", `${what} has a __proto__ key`);
        }
        visit(child);
      }
    }
    active.delete(container);
    finished.add(container);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginGenError("parse", `${what} is not an object`);
  }
  visit(value);
}
