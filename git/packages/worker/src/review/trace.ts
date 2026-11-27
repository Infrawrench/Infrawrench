/**
 * What a trace entry goes through on its way into `git_trace_entries`. The
 * rules live in server-core (`git-review/trace.ts`), shared with the app's
 * CI; this is the name the Worker's modules know them by.
 */
export * from "@infrawrench/server-core/git-review/trace";
