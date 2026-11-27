/**
 * Settings > Import in the mock. Nothing is fetched: an import that was
 * started moves on one phase each time the list is read, which is what the
 * page's polling does, so its states can all be seen.
 */
import type { IssueImport } from "@infrawrench/git-contract";
import { badRequest, conflict, defineMockHandlers, notFound, type Mutable } from "../define";
import { findRepository, requireUser, type RepositoryRecord } from "../db";
import { daysAgo, newId, person } from "../settings-data";

type ImportRecord = Mutable<IssueImport>;

const store = new Map<string, ImportRecord[]>();

const seed = (repo: RepositoryRecord): ImportRecord[] =>
  `${repo.owner.slug}/${repo.name}` === "acme/infra"
    ? [
        {
          id: "imp_1",
          source: "github",
          repository: "acme-example/infra",
          status: "done",
          phase: "finish",
          counts: { labels: 9, milestones: 2, issues: 148, comments: 611 },
          error: null,
          resumeAt: null,
          startedBy: person("mara"),
          createdAt: daysAgo(12),
          finishedAt: daysAgo(12),
        },
      ]
    : [];

const importsOf = (repo: RepositoryRecord): ImportRecord[] => {
  let found = store.get(repo.id);
  if (!found) store.set(repo.id, (found = seed(repo)));
  return found;
};

const isActive = (item: IssueImport): boolean =>
  item.status === "queued" || item.status === "running";

/** What the next read of a running import shows. */
const advance = (item: ImportRecord): void => {
  if (item.status === "queued") {
    item.status = "running";
    return;
  }
  if (item.status !== "running") return;
  if (item.phase === "labels") {
    item.counts = { ...item.counts, labels: 6 };
    item.phase = "milestones";
  } else if (item.phase === "milestones") {
    item.counts = { ...item.counts, milestones: 3 };
    item.phase = "issues";
  } else if (item.phase === "issues") {
    item.counts = { ...item.counts, issues: item.counts.issues + 40 };
    if (item.counts.issues >= 120) item.phase = "comments";
  } else if (item.phase === "comments") {
    item.counts = { ...item.counts, comments: item.counts.comments + 150 };
    if (item.counts.comments >= 450) item.phase = "finish";
  } else {
    item.status = "done";
    item.finishedAt = new Date().toISOString();
  }
};

export default defineMockHandlers({
  issueImports: {
    list: ({ params }) => {
      const imports = importsOf(findRepository(params.owner, params.repo));
      const answer = structuredClone(imports);
      imports.forEach(advance);
      return { imports: answer };
    },
    create: ({ params, payload }) => {
      const imports = importsOf(findRepository(params.owner, params.repo));
      const startedBy = requireUser();
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(payload.repository.trim())) {
        throw badRequest("Name the repository as owner/name");
      }
      if (imports.some(isActive)) {
        throw conflict("An import of this repository is already running");
      }
      const created: ImportRecord = {
        id: newId("imp"),
        source: payload.source,
        repository: payload.repository.trim(),
        status: "queued",
        phase: "labels",
        counts: { labels: 0, milestones: 0, issues: 0, comments: 0 },
        error: null,
        resumeAt: null,
        startedBy,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      };
      imports.unshift(created);
      return created;
    },
    cancel: ({ params }) => {
      const imports = importsOf(findRepository(params.owner, params.repo));
      const item = imports.find((candidate) => candidate.id === params.importId);
      if (!item) throw notFound("No such import");
      if (isActive(item)) {
        item.status = "cancelled";
        item.finishedAt = new Date().toISOString();
      }
      return item;
    },
  },
});
