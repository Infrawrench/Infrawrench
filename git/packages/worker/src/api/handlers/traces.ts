/**
 * Traces: what an agent recorded while it worked (`git_trace_entries`).
 *
 * - **Who writes.** A person with `write` on the repository (a session, or a
 *   personal token with `repo:write`; the token's scope is `runHandler`'s
 *   check, the level is checked here because the endpoint's gate is `read`,
 *   which is all a CI job's token has). An API key with `write`. A CI job's
 *   token for this repository, on the branch its run is of and no other: a
 *   job is one run of one commit, and what it records is about that work. A
 *   job of a fork's proposed branch records nothing (it is not trusted with
 *   the base repository's record), and neither does a token minted for no
 *   run. Everything else is a 403.
 * - **Masked before stored.** Every string an entry carries goes through
 *   `maskSecrets` (`review/trace.ts` `prepareTraceEntries`) on its way into
 *   the row, never on the way out: nothing unmasked is ever at rest, and the
 *   answer to `record` is the masked rows, so an agent sees what was kept.
 * - **Bounded.** `review/trace.ts` has the limits and why. The API's own
 *   admission counts the call against its caller as a write.
 * - **Claimed by the next push.** `record` only inserts rows with no
 *   version; `events/versions.ts` gives them to the version the branch's
 *   next push makes.
 *
 * Reading is the repository's readers'. A branch's trace is its versions'
 * entries and what waits on it for the next push.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  GitApi,
  type TraceEntry,
  accessAtLeast,
  forbidden,
  notFound,
  unprocessable,
} from "@infrawrench/git-contract";
import { getCiRun } from "../../db/automation";
import { decodeCursor, pageSize } from "../../db/cursor";
import {
  type TraceEntryRow,
  type TraceScope,
  insertTraceEntries,
  listTraceEntries,
  pendingTraceCounts,
  versionNumbersById,
  versionsOfBranch,
} from "../../db/traces";
import { TRACE_LIMITS, prepareAgent, prepareTraceEntries } from "../../review/trace";
import { type RepoCx, repoOp } from "../context";
import { iso, peopleById } from "../views/repositories";

/** Characters no ref name has: controls, space, and what Git gives a meaning to. */
const NOT_IN_A_REF = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

/** A branch as a trace names it: short, and a name a ref could have. */
export const traceBranch = (value: string): string => {
  const branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
  const strange = [...branch].some(
    (character) =>
      character.charCodeAt(0) <= 0x20 ||
      character.charCodeAt(0) === 0x7f ||
      NOT_IN_A_REF.has(character),
  );
  if (
    branch === "" ||
    strange ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.startsWith("refs/") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith(".lock")
  ) {
    throw unprocessable("That is not a branch name");
  }
  return branch;
};

const NEEDS_WRITE = "Recording a trace needs write access to the repository";

/**
 * Whether the caller may record on `branch`, and as whom: the person, or
 * null for a job. Throws the 403 otherwise.
 */
const authorOf = async (cx: RepoCx, branch: string): Promise<string | null> => {
  const principal = cx.principal;
  if (principal.kind === "job") {
    // `repoAccess` already holds a job's token to its own repository; this says so again.
    if (principal.repositoryId !== cx.repo.repository.id || principal.workspaceId) {
      throw forbidden("This job's token is for another repository");
    }
    if (principal.runId === null) throw forbidden("Only a CI run's own token records a trace");
    const run = await getCiRun(
      cx.repo.repository.id,
      cx.repo.owner.organizationId,
      principal.runId,
    );
    if (!run || run.fromFork) {
      throw forbidden("This job's run does not record traces on this repository");
    }
    if (run.headRef !== branch) {
      throw forbidden("This job records on the branch its run is of, and no other");
    }
    return null;
  }
  if (principal.kind !== "user" && principal.kind !== "api-key") throw forbidden(NEEDS_WRITE);
  if (!accessAtLeast(cx.access, "write")) throw forbidden(NEEDS_WRITE);
  return cx.userId;
};

const traceViews = async (rows: readonly TraceEntryRow[]): Promise<TraceEntry[]> => {
  const [person, numbers] = await Promise.all([
    peopleById(rows.map((row) => row.authorUserId)),
    versionNumbersById([
      ...new Set(rows.map((row) => row.versionId).filter((id): id is string => id !== null)),
    ]),
  ]);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    body: row.body,
    anchors: row.anchors.map((anchor) => ({
      path: anchor.path,
      startLine: anchor.startLine ?? null,
      endLine: anchor.endLine ?? null,
    })),
    evidence: row.evidence
      ? {
          command: row.evidence.command ?? null,
          exitCode: row.evidence.exitCode ?? null,
          output: row.evidence.output ?? null,
          ciRunId: row.evidence.ciRunId ?? null,
          url: row.evidence.url ?? null,
        }
      : null,
    author: person(row.authorUserId),
    agent: row.agent
      ? { kind: row.agent.kind, name: row.agent.name, sessionRef: row.agent.sessionRef ?? null }
      : null,
    branch: row.branch,
    version: row.versionId === null ? null : (numbers.get(row.versionId) ?? null),
    createdAt: iso(row.createdAt),
  }));
};

/** Which entries a `list` reads: a branch's of this repository. */
const scopeOf = async (
  cx: RepoCx,
  query: { readonly branch: string; readonly version?: string | undefined },
): Promise<TraceScope> => {
  const branch = traceBranch(query.branch);
  const versions = await versionsOfBranch(cx.repo.repository.id, branch);
  const pending: TraceScope["pending"] = { repositoryId: cx.repo.repository.id, branch };
  if (query.version === undefined) {
    return { versionIds: versions.map((version) => version.id), pending };
  }
  if (query.version === "pending") return { versionIds: [], pending };
  const wanted = versions.find((version) => version.number === Number(query.version));
  if (!wanted) throw notFound("No such version");
  return { versionIds: [wanted.id], pending: null };
};

export const TracesHandlers = HttpApiBuilder.group(GitApi, "traces", (handlers) =>
  handlers
    .handle(
      "record",
      repoOp(async (cx, { payload }) => {
        const branch = traceBranch(payload.branch);
        const authorUserId = await authorOf(cx, branch);
        if (branch === cx.repo.repository.defaultBranch) {
          throw unprocessable(
            "The default branch has no versions: record on the branch the work is on",
          );
        }
        const prepared = prepareTraceEntries(payload.entries);
        if (!Array.isArray(prepared)) {
          throw unprocessable(
            `Entry ${prepared.index + 1} is too long: a body is at most ${TRACE_LIMITS.bodyBytes} bytes`,
            "too_large",
          );
        }
        const waiting = await pendingTraceCounts(cx.repo.repository.id, branch);
        if (waiting.branch + prepared.length > TRACE_LIMITS.pendingPerBranch) {
          throw unprocessable(
            `This branch has ${waiting.branch} entries waiting for a push and takes ${TRACE_LIMITS.pendingPerBranch}: push, then record again`,
          );
        }
        if (waiting.repository + prepared.length > TRACE_LIMITS.pendingPerRepository) {
          throw unprocessable("This repository has too many trace entries waiting for a push");
        }
        const rows = await insertTraceEntries({
          repositoryId: cx.repo.repository.id,
          branch,
          authorUserId,
          agent: prepareAgent(payload.agent),
          entries: prepared,
        });
        return { entries: await traceViews(rows) };
      }),
    )
    .handle(
      "list",
      repoOp(async (cx, { query }) => {
        const scope = await scopeOf(cx, query);
        const page = await listTraceEntries(scope, {
          cursor: decodeCursor(query.cursor),
          limit: pageSize(query.limit),
        });
        return { items: await traceViews(page.items), nextCursor: page.nextCursor };
      }),
    ),
);
