/**
 * Why a plugin could not be checked. Only `network` is transient: the rest mean
 * something a person has to look at will still be wrong tomorrow.
 */
export type FailureKind =
  | "config"
  | "network"
  | "unavailable"
  | "parse"
  | "operation-removed"
  | "patch"
  | "unsafe"
  | "generator";

export class PluginGenError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = "PluginGenError";
  }
}

export function failureOf(error: unknown): { kind: FailureKind; message: string } {
  if (error instanceof PluginGenError) return { kind: error.kind, message: error.message };
  return {
    kind: "generator",
    message: error instanceof Error ? error.message : String(error),
  };
}
