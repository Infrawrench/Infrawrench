/**
 * Traces: what an agent recorded while it worked (`git_trace_entries`).
 *
 * Not built yet: every endpoint answers 503 `not_implemented`. What is
 * already in place for whoever builds it:
 *
 * - A push claims the entries waiting on its branch for the version it makes
 *   (`db/review.ts` `claimTraceEntries`, called by `events/versions.ts`), so
 *   `record` only inserts rows with `versionId` null.
 * - **Mask before storing.** Every `body` and every string of `evidence`
 *   goes through `maskSecrets` (`../../review/masking.ts`) on its way into
 *   the row, never on the way out: nothing unmasked is ever at rest.
 * - `record` is the one write a CI job's token makes with its `read`
 *   (`middleware.ts` `JOB_GROUPS`): refuse a person without `write` on the
 *   repository (`cx.access`), take a job principal for its own repository,
 *   and refuse everything else.
 * - Write handlers with `repoOp` (`../context.ts`), as every other group does.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { GitApi, notImplemented } from "@infrawrench/git-contract";

/** Until an endpoint is built it answers the contract's 503 `not_implemented`, after its gates have run. */
const unbuilt = (what: string) => Effect.die(notImplemented(what));

export const TracesHandlers = HttpApiBuilder.group(GitApi, "traces", (handlers) =>
  handlers
    .handle("record", () => unbuilt("Recording a trace"))
    .handle("list", () => unbuilt("Reading a trace")),
);
