/**
 * Instructions: what a reviewer sent to the agent that wrote the branch
 * (`git_instructions`).
 *
 * Not built yet: every endpoint answers 503 `not_implemented`. What is
 * already in place for whoever builds it:
 *
 * - The branch page counts queued and delivered instructions
 *   (`db/review.ts` `openInstructionCount`) and calls the branch
 *   `agent_working` while there are any.
 * - A version's `counts.answeredInstructions` reads
 *   `answered_in_version_number`; `markAnswered` without a version means the
 *   next one pushed, which `events/versions.ts` `recordVersions` is the place
 *   to settle.
 * - Delivery to the agent goes by its link (`git_agent_links`): `infrawrench`,
 *   `t3` (`./t3.ts`), or `mcp`, where the agent asks with `list`.
 * - Write handlers with `repoOp` (`../context.ts`), as every other group does.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { GitApi, notImplemented } from "@infrawrench/git-contract";

/** Until an endpoint is built it answers the contract's 503 `not_implemented`, after its gates have run. */
const unbuilt = (what: string) => Effect.die(notImplemented(what));

export const InstructionsHandlers = HttpApiBuilder.group(GitApi, "instructions", (handlers) =>
  handlers
    .handle("send", () => unbuilt("Sending an instruction"))
    .handle("list", () => unbuilt("Instructions"))
    .handle("markDelivered", () => unbuilt("Marking an instruction delivered"))
    .handle("markAnswered", () => unbuilt("Marking an instruction answered"))
    .handle("dismiss", () => unbuilt("Dismissing an instruction")),
);
