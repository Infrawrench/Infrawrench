/**
 * Masking secrets in what agents and reviewers record. The rules live in
 * server-core (`git-review/masking.ts`), because the app's CI writes notes
 * through them too; this is the name the Worker's modules know them by.
 */
export * from "@infrawrench/server-core/git-review/masking";
