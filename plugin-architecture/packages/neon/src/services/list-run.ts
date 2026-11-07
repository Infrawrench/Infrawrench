import {
  reportUnreadListPart,
  type ResourceInstance,
  type UnreadListPart,
} from "@infrawrench/plugin-base";
import type { Api, Branch, ProjectListItem } from "@neondatabase/api-client";
import { flatMapPooled, PollBudget, rotationStart, SharedRead, throughBudget } from "../pool.js";
import {
  httpStatus,
  isNotEnabled,
  isPermissionRefused,
  listAllProjects,
  listBranchesOfProject,
  resourceId,
  type BranchRef,
} from "./common.js";

/** What a read of many parents got, and what it says it did not read. */
export interface ChildRead<R> {
  rows: R[];
  unread: UnreadListPart[];
  /** Why the first parent the key was refused went unread, if one was. */
  refusal?: unknown;
}

/**
 * A read that left part of itself unread, where the host keeps no track of what that was
 * (the desktop, or a call outside a sync). The type is read again with no budget, which
 * leaves only refusals unread, and a refusal is thrown as it came.
 */
export class UnkeptReadError extends Error {
  constructor(readonly refusal: unknown) {
    super("Neon plugin: part of this list was left unread, where nothing keeps the rest.");
    this.name = "UnkeptReadError";
  }
}

interface ReadChildrenOptions {
  /** How many parents to read at most. */
  maxParents?: number;
  /** The answers meaning this parent has none of these. Defaults to a 404: it is gone. */
  isNone?: (err: unknown) => boolean;
  /** Its parents come from another type's read, so it starts after the rest. */
  late?: boolean;
}

/**
 * Read a child list for each parent, as far as the poll's budget goes. A parent past it
 * is named as unread, so its stored rows go stale rather than read as deleted, and the
 * start moves between polls so the rest get their turn. A failure other than the ones
 * below rejects, so stored rows stay: a throttle, a 5xx or a key Neon rejects says nothing
 * about what is there.
 *
 * A 403 is a restricted key, which is normal, so it does not fail the type: that parent
 * is named as unread too.
 *
 * Reports nothing itself, because a read shared between types has to be reported in the
 * scope of each.
 */
export async function collectChildren<P, R>(
  parents: readonly P[],
  budget: PollBudget,
  read: (parent: P) => Promise<R[]>,
  unread: (parent: P) => UnreadListPart,
  { maxParents = Number.POSITIVE_INFINITY, isNone = isNotFound, late }: ReadChildrenOptions = {},
): Promise<ChildRead<R>> {
  const parts: UnreadListPart[] = [];
  let started = 0;
  let refused = 0;
  let refusal: unknown;
  const rows = await flatMapPooled(
    parents,
    async (parent) => {
      if (started >= maxParents || !budget.hasRoom({ late: late === true })) {
        parts.push(unread(parent));
        return [];
      }
      started++;
      try {
        return await read(parent);
      } catch (err) {
        if (isPermissionRefused(err)) {
          refused++;
          refusal ??= err;
          parts.push(unread(parent));
          return [];
        }
        if (isNone(err)) return [];
        throw err;
      }
    },
    budget.slots,
    rotationStart(parents.length),
  );
  if (parents.length > 0 && refused === parents.length) parts.push({ idPrefixes: [""] });
  return { rows, unread: parts, ...(refusal !== undefined ? { refusal } : {}) };
}

function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404;
}

/**
 * Report what a read left unread, in the scope of the type asking. Throws an
 * {@link UnkeptReadError} where the host keeps no track of it. A lookup reports nothing.
 */
export function reportUnread(
  read: Pick<ChildRead<unknown>, "unread" | "refusal">,
  budget: PollBudget,
): void {
  if (!budget.reportsUnread) return;
  for (const part of read.unread) {
    if (!reportUnreadListPart(part)) throw new UnkeptReadError(read.refusal);
  }
}

/** {@link collectChildren} for a read only one type uses. */
export async function readChildren<P, R>(
  parents: readonly P[],
  budget: PollBudget,
  read: (parent: P) => Promise<R[]>,
  unread: (parent: P) => UnreadListPart,
  options?: ReadChildrenOptions,
): Promise<R[]> {
  const result = await collectChildren(parents, budget, read, unread, options);
  reportUnread(result, budget);
  return result.rows;
}

export function branchUnread(accountId: string, ref: BranchRef): UnreadListPart {
  return {
    parentResourceIds: [resourceId(accountId, "neon-branch", `${ref.projectId}/${ref.branchId}`)],
  };
}

export function projectUnread(accountId: string, project: ProjectParent): UnreadListPart {
  return { parentResourceIds: [resourceId(accountId, "neon-project", project.id)] };
}

export type ProjectParent = { id: string };
export type ProjectBranch = BranchRef & { branch: Branch };

/**
 * The reads every list hangs off, for one pass over the account: the requests go through
 * one budget, and the types running at once share the project and branch lists rather
 * than each paying for them.
 */
export class ListRun {
  readonly api: Api<unknown>;
  /** Shared here, built by the client, which knows what a database row looks like. */
  readonly databases = new SharedRead<ChildRead<ResourceInstance>>();
  private readonly projectRead = new SharedRead<ProjectListItem[]>();
  private readonly branchRead = new SharedRead<ChildRead<ProjectBranch>>();

  /** @param onlyProject Read this project's children alone, without listing the projects. */
  constructor(
    api: Api<unknown>,
    readonly budget: PollBudget,
    private readonly onlyProject?: string,
  ) {
    this.api = throughBudget(api, budget);
  }

  /** Every project. This has no parent to name, so it is read whole or it throws. */
  projectList(): Promise<ProjectListItem[]> {
    return this.projectRead.run(() => listAllProjects(this.api));
  }

  async projects(): Promise<ProjectParent[]> {
    return this.onlyProject ? [{ id: this.onlyProject }] : this.projectList();
  }

  /**
   * The projects, for a type reading one thing per project. It waits for the branches
   * another type is reading: going first, these types would spend the whole budget while
   * the branch-scoped types still had nothing to read, on every poll.
   */
  async projectsToReadChildrenOf(): Promise<ProjectParent[]> {
    const projects = await this.projects();
    await this.branchRead.settled();
    return projects;
  }

  /** Every branch in reach, and what is not, for a read that reports it later. */
  readBranches(accountId: string): Promise<ChildRead<ProjectBranch>> {
    return this.branchRead.run(async () =>
      collectChildren(
        await this.projects(),
        this.budget,
        async (p) => {
          const branches = await listBranchesOfProject(this.api, p.id);
          return branches.map((branch) => ({ projectId: p.id, branchId: branch.id, branch }));
        },
        (p) => projectUnread(accountId, p),
        { maxParents: this.budget.maxEnumeratedProjects },
      ),
    );
  }

  /** Every branch in reach, reporting what is not to the type asking. */
  async branches(accountId: string): Promise<ProjectBranch[]> {
    const read = await this.readBranches(accountId);
    reportUnread(read, this.budget);
    return read.rows;
  }

  /**
   * Read a Private Beta service off each branch in reach. A branch without the
   * entitlement answers 404 or 501, which is none.
   */
  async readBranchServices<R>(
    accountId: string,
    read: (ref: BranchRef) => Promise<R[]>,
  ): Promise<R[]> {
    return readChildren(
      await this.branches(accountId),
      this.budget,
      read,
      (ref) => branchUnread(accountId, ref),
      { isNone: isNotEnabled },
    );
  }
}
