import type { Patch } from "./config.js";
import { PluginGenError } from "./errors.js";
import { isObject, type JsonObject } from "./json.js";
import { child, decodeSegment, resolvePointer } from "./pointer.js";

/**
 * A patch that no longer changes anything, or whose parent has gone, fails the run, so
 * a provider fixing its document surfaces rather than rotting.
 */
export function applyPatches(doc: JsonObject, patches: readonly Patch[]): void {
  for (const { pointer, value } of patches) {
    const segments = pointer.split("/");
    const last = segments.pop();
    if (last === undefined) throw new PluginGenError("patch", `Patch ${pointer} has no parent`);
    const key = decodeSegment(last);
    const parent = resolvePointer(doc, `#${segments.join("/")}`);
    const isArray = Array.isArray(parent);
    if (!isArray && !isObject(parent)) {
      throw new PluginGenError("patch", `Patch ${pointer} has no parent`);
    }
    if (JSON.stringify(child(parent, key)) === JSON.stringify(value)) {
      throw new PluginGenError("patch", `Patch ${pointer} changes nothing; remove it`);
    }
    if (isArray) {
      const index = Number(key);
      if (!Number.isInteger(index)) {
        throw new PluginGenError("patch", `Patch ${pointer} does not address an array item`);
      }
      parent[index] = value;
    } else {
      parent[key] = value;
    }
  }
}
