/**
 * Parsing helpers shared by the per-domain detail renderers. Leaf module —
 * imports nothing from the plugin so every renderer can depend on it.
 */

/**
 * Best-effort JSON-array parse for catalog data stuffed into resolvedOutputs
 * by enrichDetail. Returns [] on any error so the picker degrades gracefully.
 */
export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Same, but always yields an array — used for the picker catalogs. */
export function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
