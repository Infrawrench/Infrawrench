/**
 * Repositories: the lists (`repositoryLists`), and one repository's page,
 * settings, forks and stars (`repositories`). Postgres holds the record; the
 * storage is created, copied and destroyed through the `RepoReader`.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  GitApi,
  PaymentRequired,
  REPOSITORY_NAME_MAX_LENGTH,
  type RepositoryNameAvailability,
  type RepositoryUpdate,
  accessAtLeast,
  badRequest,
  conflict,
  forbidden,
  isValidRefName,
  nameProblemMessage,
  notFound,
  ok,
  repositoryNameProblem,
  unprocessable,
} from "@infrawrench/git-contract";
import { gitPrivateRepositoryRefusal } from "@infrawrench/server-core/git/quota";
import type { RepoAccess } from "../../auth/access";
import { repoAccess } from "../../auth/repo-access";
import { moveWorkspacesToOrganization } from "../../db/automation";
import { copyCollaborators } from "../../db/collaborators";
import { type NamespaceRow, getNamespaceBySlug } from "../../db/namespaces";
import {
  type RepositoryPatch,
  type RepositoryWithOwner,
  createRepository,
  deleteRepository,
  getRepositoryById,
  isRepositoryNameTaken,
  listStargazerIds,
  recordPush,
  starRepository,
  toRepoForAccess,
  unstarRepository,
  updateRepository,
} from "../../db/repositories";
import { searchRepositories } from "../../db/repository-lists";
import { getUser } from "../../db/users";
import { RepoReaderError } from "../../repo/reader";
import { type Cx, type RepoCx, op, repoOp } from "../context";
import { peopleById, repositoryDetail, repositorySummaries } from "../views/repositories";

const flag = (value: "true" | "false" | undefined): boolean | undefined =>
  value === undefined ? undefined : value === "true";

/**
 * What the caller may do in a namespace: `admin` in their own, and what
 * their `git:*` permissions give in an organisation's. A personal token is
 * capped by its scopes.
 */
export const namespaceAccess = async (cx: Cx, namespace: NamespaceRow): Promise<RepoAccess> => {
  const viewer = await cx.viewer();
  const own: RepoAccess =
    namespace.userId !== null && namespace.userId === viewer.userId
      ? "admin"
      : (viewer.organizations.find((organization) => organization.id === namespace.organizationId)
          ?.access ?? "none");
  return accessAtLeast(viewer.cap, own) ? own : viewer.cap;
};

/** The namespace a repository is to land in, when the caller may put it there. */
const targetNamespace = async (
  cx: Cx,
  slug: string,
  need: "write" | "admin",
): Promise<NamespaceRow> => {
  const namespace = await getNamespaceBySlug(slug);
  if (!namespace) throw notFound("No such user or organisation");
  const access = await namespaceAccess(cx, namespace);
  if (!accessAtLeast(access, need)) {
    // Membership of an organisation is not public: a stranger learns nothing more than "not yours".
    throw forbidden(
      namespace.kind === "org"
        ? `This needs git:${need} in that organisation`
        : "That is somebody else's namespace",
    );
  }
  return namespace;
};

const checkName = (name: string): void => {
  const problem = repositoryNameProblem(name);
  if (problem !== null) {
    throw badRequest(nameProblemMessage(problem, REPOSITORY_NAME_MAX_LENGTH), "name_invalid");
  }
};

/**
 * Private repositories follow the owner's plan: how many an organisation's
 * plan or a person's own allowance includes (server-core `git/quota.ts`).
 */
const checkPrivateAllowed = async (namespace: {
  readonly organizationId: string | null;
  readonly userId: string | null;
}): Promise<void> => {
  const refusal = await gitPrivateRepositoryRefusal(namespace);
  if (refusal !== null) throw new PaymentRequired({ error: refusal, code: "plan_required" });
};

/** What `create` and `rename` would say of a name, without doing either. */
const nameAvailability = async (
  namespaceId: string,
  name: string,
  exceptId?: string,
): Promise<RepositoryNameAvailability> => {
  const problem = repositoryNameProblem(name);
  if (problem !== null) {
    return {
      name,
      available: false,
      reason: "invalid",
      message: nameProblemMessage(problem, REPOSITORY_NAME_MAX_LENGTH),
    };
  }
  return (await isRepositoryNameTaken(namespaceId, name, exceptId))
    ? {
        name,
        available: false,
        reason: "taken",
        message: "A repository with that name exists here",
      }
    : { name, available: true, reason: null, message: null };
};

const identityOf = async (cx: Cx) => {
  const user = cx.userId ? await getUser(cx.userId) : null;
  return {
    name: user?.displayName ?? cx.username ?? "Infrawrench",
    email: user?.email ?? "noreply@infrawrench.com",
  };
};

const reload = async (cx: Cx, id: string) => {
  const found = await getRepositoryById(id);
  if (!found) throw notFound("Repository not found");
  const decision = await repoAccess.detail(cx.principal, toRepoForAccess(found));
  return repositoryDetail(cx, found, {
    access: decision.access === "none" ? "read" : decision.access,
    unarchived: decision.unarchived,
  });
};

const listInput = (query: {
  readonly cursor?: string;
  readonly limit?: number;
  readonly q?: string;
  readonly sort?: "pushed" | "name" | "stars" | "created";
  readonly direction?: "asc" | "desc";
}) => ({
  cursor: query.cursor,
  limit: query.limit,
  q: query.q,
  sort: query.sort,
  direction: query.direction,
});

const page = async (
  cx: Cx,
  found: { items: RepositoryWithOwner[]; nextCursor: string | null },
) => ({
  items: await repositorySummaries(cx, found.items),
  nextCursor: found.nextCursor,
});

export const RepositoryListsHandlers = HttpApiBuilder.group(GitApi, "repositoryLists", (handlers) =>
  handlers
    .handle(
      "create",
      op(async (cx, { payload }) => {
        const namespace = await targetNamespace(cx, payload.owner, "write");
        checkName(payload.name);
        const defaultBranch = payload.defaultBranch ?? "main";
        if (!isValidRefName(defaultBranch)) {
          throw badRequest("That is not a valid branch name", "name_invalid");
        }
        if (payload.visibility === "private") await checkPrivateAllowed(namespace);
        const row = await createRepository({
          namespaceId: namespace.id,
          name: payload.name,
          description: payload.description ?? null,
          visibility: payload.visibility,
          defaultBranch,
          createdByUserId: cx.userId,
        });
        if (!row) throw conflict("A repository with that name exists there", "name_taken");
        try {
          const storage = cx.reader({ id: row.id, owner: namespace.slug, name: row.name });
          const { headOid } = await storage.init({
            defaultBranch,
            initialize: payload.initialize
              ? {
                  readme: payload.initialize.readme,
                  gitignore: payload.initialize.gitignore,
                  license: payload.initialize.license,
                  author: await identityOf(cx),
                  title: row.name,
                  description: row.description,
                }
              : undefined,
          });
          if (headOid !== null) {
            // The first commit is made by the storage and sends no push event: its sizes are read here.
            const stats = await storage.stats();
            await recordPush(row.id, {
              at: new Date(),
              sizeBytes: stats.sizeBytes,
              branchesCount: stats.branchCount,
              tagsCount: stats.tagCount,
              isEmpty: stats.isEmpty,
            });
          }
        } catch (error) {
          // A record without storage is a repository nobody can push to.
          await deleteRepository(row.id);
          throw error;
        }
        return reload(cx, row.id);
      }),
    )
    .handle(
      "nameAvailability",
      op(async (cx, { params, query }) => {
        // The same gate as `create`: only someone who may create here is told what is taken.
        const namespace = await targetNamespace(cx, params.namespace, "write");
        return nameAvailability(namespace.id, query.name);
      }),
    )
    .handle(
      "listForNamespace",
      op(async (cx, { params, query }) => {
        const namespace = await getNamespaceBySlug(params.namespace);
        if (!namespace) throw notFound("No such user or organisation");
        return page(
          cx,
          await searchRepositories({
            ...listInput(query),
            viewer: await cx.viewer(),
            namespaceId: namespace.id,
            type: query.type,
          }),
        );
      }),
    )
    .handle(
      "listStarredBy",
      op(async (cx, { params, query }) => {
        const namespace = await getNamespaceBySlug(params.namespace);
        if (!namespace || namespace.userId === null) throw notFound("No such user");
        return page(
          cx,
          await searchRepositories({
            viewer: await cx.viewer(),
            starredByUserId: namespace.userId,
            sort: "starred",
            cursor: query.cursor,
            limit: query.limit,
          }),
        );
      }),
    )
    .handle(
      "listMine",
      op(async (cx, { query }) => {
        const viewer = await cx.viewer();
        const access = query.access ?? "read";
        return page(
          cx,
          await searchRepositories({
            ...listInput(query),
            viewer,
            mine: {
              access,
              organizationIds: viewer.organizations
                .filter((organization) => accessAtLeast(organization.access, access))
                .map((organization) => organization.id),
            },
          }),
        );
      }),
    )
    .handle(
      "explore",
      op(async (cx, { query }) =>
        page(
          cx,
          await searchRepositories({
            ...listInput(query),
            sort: query.sort ?? "stars",
            viewer: await cx.viewer(),
            language: query.language,
            topic: query.topic,
            includeForks: flag(query.includeForks) ?? false,
          }),
        ),
      ),
    ),
);

const TOPIC = /^[a-z0-9][a-z0-9-]{0,34}$/;

const patchOf = (payload: RepositoryUpdate): RepositoryPatch => {
  const patch: RepositoryPatch = {};
  if (payload.description !== undefined) patch.description = payload.description;
  if (payload.homepageUrl !== undefined) {
    if (payload.homepageUrl !== null && !/^https?:\/\//i.test(payload.homepageUrl)) {
      throw badRequest("The homepage must be an http or https URL");
    }
    patch.homepageUrl = payload.homepageUrl;
  }
  if (payload.topics !== undefined) {
    const topics = [...new Set(payload.topics.map((topic) => topic.trim().toLowerCase()))];
    if (!topics.every((topic) => TOPIC.test(topic))) {
      throw badRequest("Topics use lowercase letters, digits and dashes, up to 35 characters");
    }
    patch.topics = topics;
  }
  if (payload.features?.issues !== undefined) patch.hasIssues = payload.features.issues;
  if (payload.features?.pullRequests !== undefined) {
    patch.hasPullRequests = payload.features.pullRequests;
  }
  const merge = payload.merge;
  if (merge?.allowMergeCommit !== undefined) patch.allowMergeCommit = merge.allowMergeCommit;
  if (merge?.allowSquash !== undefined) patch.allowSquash = merge.allowSquash;
  if (merge?.allowRebase !== undefined) patch.allowRebase = merge.allowRebase;
  if (merge?.defaultMethod !== undefined) patch.defaultMergeMethod = merge.defaultMethod;
  if (merge?.deleteBranchOnMerge !== undefined)
    patch.deleteBranchOnMerge = merge.deleteBranchOnMerge;
  if (payload.archived !== undefined) patch.archived = payload.archived;
  return patch;
};

/** A fork of a private repository stays private, within the same owner's reach. */
const privateParent = async (repo: RepositoryWithOwner): Promise<RepositoryWithOwner | null> => {
  if (!repo.repository.forkOfId) return null;
  const parent = await getRepositoryById(repo.repository.forkOfId);
  return parent && parent.repository.visibility === "private" ? parent : null;
};

/** When each repository was last asked to be measured, in this isolate. */
const languagesAsked = new Map<string, number>();
const LANGUAGES_ASK_EVERY_MS = 10 * 60_000;

/**
 * A repository pushed to before languages were measured has none until its
 * next push. Opening it asks the queue to measure it, at most every ten
 * minutes per isolate, so page views cannot flood the queue.
 */
const requestLanguages = (cx: RepoCx): void => {
  const { repository } = cx.repo;
  if (repository.isEmpty || repository.languagesCommit !== null) return;
  const now = Date.now();
  if (now - (languagesAsked.get(repository.id) ?? 0) < LANGUAGES_ASK_EVERY_MS) return;
  languagesAsked.set(repository.id, now);
  if (languagesAsked.size > 10_000) languagesAsked.clear();
  // Inside the promise: a failure to send is background work's to log, never the page's.
  cx.background(
    Promise.resolve().then(() => cx.env.EVENTS.send({ type: "languages", repoId: repository.id })),
  );
};

export const RepositoriesHandlers = HttpApiBuilder.group(GitApi, "repositories", (handlers) =>
  handlers
    .handle(
      "get",
      repoOp((cx) => {
        requestLanguages(cx);
        return repositoryDetail(cx, cx.repo, cx);
      }),
    )
    .handle(
      "update",
      repoOp(async (cx, { payload }) => {
        const { repository } = cx.repo;
        // On an archived repository only unarchiving goes through.
        if (repository.archived && payload.archived !== false) {
          throw forbidden("This repository is archived and read-only", "repository_archived");
        }
        const patch = patchOf(payload);
        const merged = { ...repository, ...patch };
        if (!merged.allowMergeCommit && !merged.allowSquash && !merged.allowRebase) {
          throw unprocessable("At least one merge method must stay allowed");
        }
        const allowed = {
          merge: merged.allowMergeCommit,
          squash: merged.allowSquash,
          rebase: merged.allowRebase,
        };
        if (!allowed[merged.defaultMergeMethod]) {
          throw unprocessable(
            "The default merge method must be one that is allowed",
            "merge_method_not_allowed",
          );
        }
        if (
          payload.defaultBranch !== undefined &&
          payload.defaultBranch !== repository.defaultBranch
        ) {
          try {
            await cx.git.setDefaultBranch(payload.defaultBranch);
          } catch (error) {
            if (error instanceof RepoReaderError && error.code === "ref_not_found") {
              throw unprocessable("There is no such branch", "ref_not_found");
            }
            throw error;
          }
          patch.defaultBranch = payload.defaultBranch;
        }
        await updateRepository(repository.id, patch);
        return reload(cx, repository.id);
      }),
    )
    .handle(
      "rename",
      repoOp(async (cx, { payload }) => {
        checkName(payload.name);
        if (payload.name !== cx.repo.repository.name) {
          const renamed = await updateRepository(cx.repo.repository.id, { name: payload.name });
          if (!renamed) throw conflict("A repository with that name exists here", "name_taken");
        }
        return reload(cx, cx.repo.repository.id);
      }),
    )
    .handle(
      "renameAvailability",
      repoOp((cx, { query }) =>
        nameAvailability(cx.repo.repository.namespaceId, query.name, cx.repo.repository.id),
      ),
    )
    .handle(
      "transfer",
      repoOp(async (cx, { payload }) => {
        const { repository } = cx.repo;
        const namespace = await targetNamespace(cx, payload.owner, "admin");
        if (namespace.id === repository.namespaceId) return reload(cx, repository.id);
        if (await privateParent(cx.repo)) {
          throw badRequest("A fork of a private repository stays with its owner");
        }
        if (repository.visibility === "private") await checkPrivateAllowed(namespace);
        const moved = await updateRepository(repository.id, { namespaceId: namespace.id });
        if (!moved) throw conflict("A repository with that name exists there", "name_taken");
        // Its Terraform workspaces read accounts of the organisation that owns it, never the old one's.
        await moveWorkspacesToOrganization(repository.id, namespace.organizationId);
        return reload(cx, repository.id);
      }),
    )
    .handle(
      "setVisibility",
      repoOp(async (cx, { payload }) => {
        const { repository, owner } = cx.repo;
        if (payload.visibility !== repository.visibility) {
          if (payload.visibility === "public" && (await privateParent(cx.repo))) {
            throw unprocessable("A fork of a private repository cannot be made public");
          }
          if (payload.visibility === "private") await checkPrivateAllowed(owner);
          await updateRepository(repository.id, { visibility: payload.visibility });
        }
        return reload(cx, repository.id);
      }),
    )
    .handle(
      "delete",
      repoOp(async (cx, { query }) => {
        const { repository, owner } = cx.repo;
        if (query.confirm.toLowerCase() !== `${owner.slug}/${repository.name}`.toLowerCase()) {
          throw badRequest("Type the repository's full name to confirm");
        }
        await deleteRepository(repository.id);
        // The row is gone, so nothing can reach the objects: removing them can outlive the answer.
        cx.background(cx.git.destroy());
        return ok;
      }),
    )
    .handle(
      "fork",
      repoOp(async (cx, { payload }) => {
        const parent = cx.repo;
        const namespace = await targetNamespace(cx, payload.owner, "write");
        const name = payload.name ?? parent.repository.name;
        checkName(name);
        const isPrivate = parent.repository.visibility === "private";
        if (isPrivate) {
          if (namespace.id !== parent.repository.namespaceId) {
            throw unprocessable(
              "A private repository can only be forked within its owner's namespace",
            );
          }
          await checkPrivateAllowed(namespace);
        }
        const row = await createRepository({
          namespaceId: namespace.id,
          name,
          description: parent.repository.description,
          visibility: parent.repository.visibility,
          defaultBranch: parent.repository.defaultBranch,
          createdByUserId: cx.userId,
          forkOfId: parent.repository.id,
        });
        if (!row) throw conflict("A repository with that name exists there", "name_taken");
        try {
          const stats = await cx
            .reader({ id: row.id, owner: namespace.slug, name: row.name })
            .forkFrom(parent.repository.id, {
              defaultBranchOnly: payload.defaultBranchOnly ?? false,
            });
          await recordPush(row.id, {
            at: new Date(),
            sizeBytes: stats.sizeBytes,
            branchesCount: stats.branchCount,
            tagsCount: stats.tagCount,
            isEmpty: stats.isEmpty,
            primaryLanguage: parent.repository.primaryLanguage,
          });
          // As on GitHub, a fork within the same owner starts with its
          // parent's collaborators. So a private fork shows its commits to the
          // people its parent did, and a pull request between the two shows
          // them nobody new until either list changes (git/SECURITY-REVIEW.md 2.1).
          if (namespace.id === parent.repository.namespaceId) {
            await copyCollaborators(parent.repository.id, row.id, cx.userId);
          }
        } catch (error) {
          await deleteRepository(row.id);
          throw error;
        }
        return reload(cx, row.id);
      }),
    )
    .handle(
      "listForks",
      repoOp(async (cx, { query }) =>
        page(
          cx,
          await searchRepositories({
            viewer: await cx.viewer(),
            forkOfId: cx.repo.repository.id,
            cursor: query.cursor,
            limit: query.limit,
          }),
        ),
      ),
    )
    .handle(
      "star",
      repoOp(async (cx) => {
        await starRepository(cx.userId!, cx.repo.repository.id);
        return ok;
      }),
    )
    .handle(
      "unstar",
      repoOp(async (cx) => {
        await unstarRepository(cx.userId!, cx.repo.repository.id);
        return ok;
      }),
    )
    .handle(
      "listStargazers",
      repoOp(async (cx, { query }) => {
        const stars = await listStargazerIds(cx.repo.repository.id, query);
        const person = await peopleById(stars.items.map((star) => star.userId));
        return {
          items: stars.items.flatMap((star) => person(star.userId) ?? []),
          nextCursor: stars.nextCursor,
        };
      }),
    ),
);
