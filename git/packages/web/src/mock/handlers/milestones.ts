import { conflict, defineMockHandlers, notFound, ok } from "../define";
import { findRepository, type RepositoryRecord } from "../db";
import { newId } from "../settings-data";
import { milestoneWithCounts, threadsOf } from "../threads-data";

function find(repo: RepositoryRecord, number: number) {
  const found = threadsOf(repo).milestones.find((item) => item.number === number);
  if (!found) throw notFound("Milestone not found");
  return found;
}

function unique(repo: RepositoryRecord, title: string, except?: number): void {
  const clash = threadsOf(repo).milestones.some(
    (item) => item.number !== except && item.title.toLowerCase() === title.toLowerCase(),
  );
  if (clash) throw conflict("A milestone with that title exists", "name_taken");
}

export default defineMockHandlers({
  milestones: {
    list: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const state = query?.state ?? "open";
      return {
        milestones: threadsOf(repo)
          .milestones.filter((item) => state === "all" || item.state === state)
          .map((item) => milestoneWithCounts(repo, item))
          .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999")),
      };
    },
    create: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      unique(repo, payload.title);
      const store = threadsOf(repo);
      const item = {
        id: newId("ms"),
        number: store.nextMilestone++,
        title: payload.title.trim(),
        description: payload.description ?? null,
        state: "open" as const,
        dueOn: payload.dueOn ?? null,
        createdAt: new Date().toISOString(),
        closedAt: null,
      };
      store.milestones.push(item);
      return milestoneWithCounts(repo, item);
    },
    get: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return milestoneWithCounts(repo, find(repo, params.milestone));
    },
    update: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const item = find(repo, params.milestone);
      if (payload.title !== undefined) {
        unique(repo, payload.title, item.number);
        item.title = payload.title.trim();
      }
      if (payload.description !== undefined) item.description = payload.description;
      if (payload.dueOn !== undefined) item.dueOn = payload.dueOn;
      if (payload.state !== undefined && payload.state !== item.state) {
        item.state = payload.state;
        item.closedAt = payload.state === "closed" ? new Date().toISOString() : null;
      }
      return milestoneWithCounts(repo, item);
    },
    delete: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const store = threadsOf(repo);
      find(repo, params.milestone);
      store.milestones = store.milestones.filter((item) => item.number !== params.milestone);
      for (const thread of store.threads) {
        if (thread.milestone === params.milestone) thread.milestone = null;
      }
      return ok;
    },
  },
});
