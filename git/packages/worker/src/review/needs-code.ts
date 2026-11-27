/**
 * `needsCode`: whether a reader has to see the code an entry is about. The
 * rule lives in server-core (`git-review/needs-code.ts`), shared with the
 * app's CI; this is the name the Worker's modules know it by.
 */
export * from "@infrawrench/server-core/git-review/needs-code";
