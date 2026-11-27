import { defineMockHandlers, notFound, paginate, unprocessable } from "../define";
import {
  APP_URL,
  type RepositoryRecord,
  findRepository,
  gitOf,
  requireUser,
  runsInOf as runsIn,
} from "../db";
import { flatten, resolveRef } from "../git";
import { combine, logFrames, reportStatus, runsOf, statusesFor, toDetail, toRun } from "../ci-data";
import { newId } from "../settings-data";

const NEEDS_ORGANISATION =
  "CI runs in an organisation. Choose one for your own repositories in Settings > Profile";

const ciAppUrl = (repo: RepositoryRecord): string | null => {
  const organizationId = runsIn(repo);
  return organizationId === null ? null : `${APP_URL}/org/${organizationId}/ci`;
};

/** Repositories whose CI switch someone turned off. No entry means on. */
const switchedOff = new Set<string>();

export default defineMockHandlers({
  statuses: {
    forRef: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const sha = resolveRef(gitOf(repo), query?.ref).commitOid;
      const statuses = statusesFor(repo, sha);
      return { sha, state: combine(statuses), statuses };
    },
    create: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const creator = requireUser();
      const fx = gitOf(repo);
      const sha = fx.order.find((oid) => oid === params.sha.toLowerCase());
      if (sha === undefined) throw unprocessable("No such commit", "ref_not_found");
      const now = new Date().toISOString();
      const status = {
        id: newId("status"),
        context: payload.context,
        state: payload.state,
        description: payload.description ?? null,
        targetUrl: payload.targetUrl ?? null,
        runId: null,
        creator,
        createdAt: now,
        updatedAt: now,
      };
      reportStatus(repo, sha, status);
      return status;
    },
  },
  ci: {
    status: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const pipelines: Array<{ file: string; name: string }> = [];
      if (repo.fixture !== null) {
        const fx = gitOf(repo);
        for (const [path, [, oid]] of flatten(fx, fx.branches[fx.defaultBranch]!)) {
          if (!/^\.infrawrench\/ci\/[^/]+\.ya?ml$/.test(path)) continue;
          const blob = fx.blobs[oid];
          const name = blob && !blob.binary ? /^name:\s*(.+)$/m.exec(blob.text)?.[1] : undefined;
          pipelines.push({ file: path, name: name?.trim() ?? path.split("/").pop()! });
        }
      }
      const reason =
        runsIn(repo) === null
          ? NEEDS_ORGANISATION
          : switchedOff.has(repo.id)
            ? "CI is switched off for this repository"
            : null;
      return { enabled: reason === null, pipelines, reason };
    },
    settings: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return {
        enabled: !switchedOff.has(repo.id),
        available: runsIn(repo) !== null,
        appUrl: ciAppUrl(repo),
      };
    },
    updateSettings: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      requireUser();
      if (runsIn(repo) === null) throw unprocessable(NEEDS_ORGANISATION, "ci_unavailable");
      if (payload.enabled) switchedOff.delete(repo.id);
      else switchedOff.add(repo.id);
      return { enabled: payload.enabled, available: true, appUrl: ciAppUrl(repo) };
    },
    listRuns: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const runs = runsOf(repo)
        .map(toRun)
        .filter(
          (run) =>
            (query?.sha === undefined || run.sha === query.sha) &&
            (query?.ref === undefined || run.headRef === query.ref) &&
            (query?.page === undefined || run.branchPage === query.page) &&
            (query?.event === undefined || run.event === query.event) &&
            (query?.status === undefined ? run.status !== "skipped" : run.status === query.status),
        );
      return paginate(runs, query);
    },
    getRun: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const record = runsOf(repo).find((item) => item.run.id === params.runId);
      if (!record) throw notFound("Run not found");
      return toDetail(record);
    },
    runLog: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const record = runsOf(repo).find((item) => item.run.id === params.runId);
      if (!record) throw notFound("Run not found");
      return logFrames(record);
    },
  },
});
