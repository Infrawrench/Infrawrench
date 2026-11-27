/**
 * Issue imports (Settings > Import): starting one, listing a repository's,
 * and cancelling one. The work itself is the jobs queue's (`import/job.ts`);
 * a handler writes the row and sends its first message. The GitHub client is
 * loaded by the job, never here.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  type IssueImport,
  GitApi,
  SOURCE_REPOSITORY_PATTERN,
  badRequest,
  conflict,
  notFound,
  unprocessable,
} from "@infrawrench/git-contract";
import {
  type IssueImportRow,
  cancelIssueImport,
  createIssueImport,
  listIssueImports,
  markIssueImportDue,
  recountAfterImport,
} from "../../import/store";
import { enqueueJob } from "../../jobs/consumer";
import { repoOp } from "../context";
import { iso, isoOrNull, peopleById } from "../views/repositories";

const importViews = async (rows: readonly IssueImportRow[]): Promise<IssueImport[]> => {
  const person = await peopleById(rows.map((row) => row.startedByUserId));
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    repository: row.sourceRepository,
    status: row.status,
    phase: row.phase,
    counts: {
      labels: row.progress.labels,
      milestones: row.progress.milestones,
      issues: row.progress.issues,
      comments: row.progress.comments,
    },
    error: row.error,
    resumeAt: isoOrNull(row.resumeAt),
    startedBy: person(row.startedByUserId),
    createdAt: iso(row.createdAt),
    finishedAt: isoOrNull(row.finishedAt),
  }));
};

export const IssueImportsHandlers = HttpApiBuilder.group(GitApi, "issueImports", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx) => ({
        imports: await importViews(await listIssueImports(cx.repo.repository.id)),
      })),
    )
    .handle(
      "create",
      repoOp(async (cx, { payload }) => {
        const { repository } = cx.repo;
        if (!repository.hasIssues) throw unprocessable("Issues are switched off here");
        const source = payload.repository.trim();
        if (!SOURCE_REPOSITORY_PATTERN.test(source)) {
          throw badRequest("Name the repository as owner/name");
        }
        const token = payload.token.trim();
        if (token === "" || /\s/.test(token)) throw badRequest("That is not a token");
        const row = await createIssueImport({
          repositoryId: repository.id,
          sourceRepository: source,
          token,
          startedByUserId: cx.userId,
        });
        if (!row) throw conflict("An import of this repository is already running");
        // No queue (a Worker without one, a test): the sweep takes it on its next pass.
        if (!(await enqueueJob(cx.env, { type: "issue-import", importId: row.id }))) {
          await markIssueImportDue(row.id);
        }
        const [view] = await importViews([row]);
        return view!;
      }),
    )
    .handle(
      "cancel",
      repoOp(async (cx, { params }) => {
        const row = await cancelIssueImport(cx.repo.repository.id, params.importId);
        if (!row) throw notFound("No such import");
        // What it wrote before it was stopped stays, and is counted.
        if (row.status === "cancelled") await recountAfterImport(cx.repo.repository.id);
        const [view] = await importViews([row]);
        return view!;
      }),
    ),
);
