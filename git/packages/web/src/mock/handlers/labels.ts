import { conflict, defineMockHandlers, notFound, ok } from "../define";
import { findRepository, type RepositoryRecord } from "../db";
import { newId } from "../settings-data";
import { threadsOf } from "../threads-data";

function unique(repo: RepositoryRecord, name: string, exceptId?: string): void {
  const clash = threadsOf(repo).labels.some(
    (label) => label.id !== exceptId && label.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw conflict("A label with that name exists", "name_taken");
}

export default defineMockHandlers({
  labels: {
    list: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return {
        labels: [...threadsOf(repo).labels].sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    create: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      unique(repo, payload.name);
      const label = {
        id: newId("label"),
        name: payload.name.trim(),
        color: payload.color.toLowerCase(),
        description: payload.description ?? null,
      };
      threadsOf(repo).labels.push(label);
      return label;
    },
    update: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const label = threadsOf(repo).labels.find((item) => item.id === params.labelId);
      if (!label) throw notFound("Label not found");
      if (payload.name !== undefined) {
        unique(repo, payload.name, label.id);
        label.name = payload.name.trim();
      }
      if (payload.color !== undefined) label.color = payload.color.toLowerCase();
      if (payload.description !== undefined) label.description = payload.description;
      return label;
    },
    delete: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const store = threadsOf(repo);
      store.labels = store.labels.filter((label) => label.id !== params.labelId);
      for (const thread of store.threads) {
        thread.labelIds = thread.labelIds.filter((id) => id !== params.labelId);
      }
      return ok;
    },
  },
});
