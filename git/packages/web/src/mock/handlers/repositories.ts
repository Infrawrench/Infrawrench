import {
  REPOSITORY_NAME_MAX_LENGTH,
  nameProblemMessage,
  repositoryNameProblem,
} from "@infrawrench/git-contract";
import { ApiError } from "../../api/client";
import { badRequest, conflict, defineMockHandlers, mockError, ok, paginate } from "../define";
import {
  createRepository,
  currentUser,
  findNamespace,
  findRepository,
  isMember,
  removeRepository,
  repositories,
  privateRefusal,
  requireUser,
  toRepository,
  toSummary,
  visibleRepositories,
  type RepositoryRecord,
} from "../db";

interface ListQuery {
  readonly q?: string | undefined;
  readonly sort?: "pushed" | "name" | "stars" | "created" | undefined;
  readonly direction?: "asc" | "desc" | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

function listed(records: RepositoryRecord[], query: ListQuery | undefined) {
  const words = (query?.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matching = records.filter((repo) => {
    const text = `${repo.owner.slug}/${repo.name} ${repo.description ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const sort = query?.sort ?? "pushed";
  const direction = query?.direction ?? (sort === "name" ? "asc" : "desc");
  const key = (repo: RepositoryRecord): string | number =>
    sort === "name"
      ? repo.name.toLowerCase()
      : sort === "stars"
        ? repo.stars.size
        : sort === "created"
          ? repo.createdAt
          : (repo.pushedAt ?? "");
  matching.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    const order = x < y ? -1 : x > y ? 1 : 0;
    return direction === "asc" ? order : -order;
  });
  const page = paginate(matching, query);
  return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
}

function checkName(name: string, owner: string, except?: RepositoryRecord) {
  const problem = repositoryNameProblem(name);
  if (problem !== null) {
    throw badRequest(nameProblemMessage(problem, REPOSITORY_NAME_MAX_LENGTH), "name_invalid");
  }
  const clash = repositories.find(
    (r) =>
      r !== except &&
      r.owner.slug.toLowerCase() === owner.toLowerCase() &&
      r.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw conflict("A repository with that name exists here", "name_taken");
}

/** The 402 a namespace at its plan's limit answers, in the quota's own words. */
function checkPrivateAllowed(namespace: ReturnType<typeof findNamespace>): void {
  const refusal = privateRefusal(namespace);
  if (refusal !== null) throw mockError(402, refusal, "plan_required");
}

function availability(name: string, owner: string, except?: RepositoryRecord) {
  try {
    checkName(name, owner, except);
    return { name, available: true, reason: null, message: null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      name,
      available: false,
      reason: error.code === "name_taken" ? ("taken" as const) : ("invalid" as const),
      message: error.message,
    };
  }
}

export default defineMockHandlers({
  repositoryLists: {
    create: ({ payload }) => {
      requireUser();
      const namespace = findNamespace(payload.owner);
      if (!isMember(namespace)) throw mockError(404, "No user or organisation by that name");
      checkName(payload.name, namespace.slug);
      if (payload.visibility === "private") checkPrivateAllowed(namespace);
      const record = createRepository({
        owner: namespace.slug,
        name: payload.name,
        description: payload.description ?? null,
        visibility: payload.visibility,
        // An initialised repository gets the small fixture's history; an
        // uninitialised one is empty and shows the push instructions.
        fixture: payload.initialize?.readme === true ? "edge-router" : null,
        language: payload.initialize?.readme === true ? "TypeScript" : null,
      });
      return toRepository(record);
    },
    nameAvailability: ({ params, query }) => {
      requireUser();
      const namespace = findNamespace(params.namespace);
      if (!isMember(namespace)) throw mockError(403, "That is somebody else's namespace");
      return availability(query.name, namespace.slug);
    },
    listForNamespace: ({ params, query }) => {
      const namespace = findNamespace(params.namespace);
      const type = query?.type ?? "all";
      const records = visibleRepositories().filter(
        (repo) =>
          repo.owner.slug === namespace.slug &&
          (type === "all" ||
            (type === "sources" && !repo.isFork) ||
            (type === "forks" && repo.isFork) ||
            (type === "archived" && repo.archived) ||
            (type === "private" && repo.visibility === "private")),
      );
      return listed(records, query);
    },
    listStarredBy: ({ params, query }) => {
      const namespace = findNamespace(params.namespace);
      const records = visibleRepositories().filter(
        (repo) => namespace.userId !== null && repo.stars.has(namespace.userId),
      );
      return listed(records, query);
    },
    listMine: ({ query }) => {
      requireUser();
      const records = visibleRepositories().filter((repo) =>
        isMember(findNamespace(repo.owner.slug)),
      );
      return listed(records, query);
    },
    explore: ({ query }) => {
      const records = repositories.filter(
        (repo) =>
          repo.visibility === "public" &&
          (query?.includeForks === "true" || !repo.isFork) &&
          (query?.language === undefined ||
            repo.primaryLanguage?.toLowerCase() === query.language.toLowerCase()) &&
          (query?.topic === undefined || repo.topics.includes(query.topic)),
      );
      return listed(records, { ...query, sort: query?.sort ?? "stars" });
    },
  },
  repositories: {
    get: ({ params }) => toRepository(findRepository(params.owner, params.repo)),
    update: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      if (payload.description !== undefined) repo.description = payload.description;
      if (payload.homepageUrl !== undefined) repo.homepageUrl = payload.homepageUrl;
      if (payload.topics !== undefined) repo.topics = [...payload.topics];
      if (payload.defaultBranch !== undefined) repo.defaultBranch = payload.defaultBranch;
      if (payload.archived !== undefined) repo.archived = payload.archived;
      if (payload.features) repo.features = { ...repo.features, ...payload.features };
      if (payload.merge) repo.merge = { ...repo.merge, ...payload.merge };
      return toRepository(repo);
    },
    rename: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      checkName(payload.name, repo.owner.slug, repo);
      repo.name = payload.name;
      return toRepository(repo);
    },
    renameAvailability: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      return availability(query.name, repo.owner.slug, repo);
    },
    setVisibility: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      if (payload.visibility === "private" && repo.visibility !== "private") {
        checkPrivateAllowed(findNamespace(repo.owner.slug));
      }
      repo.visibility = payload.visibility;
      return toRepository(repo);
    },
    delete: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      if (query.confirm !== `${repo.owner.slug}/${repo.name}`) {
        throw badRequest("Type the repository's full name to confirm");
      }
      removeRepository(repo);
      return ok;
    },
    fork: ({ params, payload }) => {
      const user = requireUser();
      const parent = findRepository(params.owner, params.repo);
      if (user.username === null)
        throw mockError(403, "Pick a username first", "username_required");
      const target = findNamespace(payload.owner);
      if (!isMember(target)) throw mockError(404, "No user or organisation by that name");
      const name = payload.name ?? parent.name;
      checkName(name, target.slug);
      if (parent.visibility === "private") {
        if (target.slug !== parent.owner.slug) {
          throw mockError(
            422,
            "A private repository can only be forked within its owner's namespace",
          );
        }
        checkPrivateAllowed(target);
      }
      const fork = createRepository({
        owner: target.slug,
        name,
        description: parent.description,
        visibility: parent.visibility,
        fixture: parent.fixture,
        language: parent.primaryLanguage,
      });
      fork.isFork = true;
      fork.parent = {
        id: parent.id,
        owner: parent.owner.slug,
        name: parent.name,
        visibility: parent.visibility,
      };
      parent.forkCount += 1;
      return toRepository(fork);
    },
    listForks: ({ params, query }) => {
      const parent = findRepository(params.owner, params.repo);
      return listed(
        visibleRepositories().filter((repo) => repo.parent?.id === parent.id),
        query,
      );
    },
    star: ({ params }) => {
      findRepository(params.owner, params.repo).stars.add(requireUser().id);
      return ok;
    },
    unstar: ({ params }) => {
      findRepository(params.owner, params.repo).stars.delete(requireUser().id);
      return ok;
    },
    listStargazers: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const user = currentUser();
      return paginate(user && repo.stars.has(user.id) ? [user] : [], query);
    },
  },
});
