import {
  ListPageError,
  ListTruncatedError,
  reportUnreadListPart,
  requireListPage,
  withinListCap,
  type ListPlace,
  type UnreadListPart,
} from "@infrawrench/plugin-base";
import type { Api, Branch, ProjectListItem } from "@neondatabase/api-client";
import { flatMapPooled } from "../pool.js";

const VENDOR = "Neon";

/** The document's maximum for `GET /projects`; its default of 10 is far too small. */
const PROJECT_PAGE_SIZE = 400;
/** 100,000 projects, the most a resource sync takes. */
const MAX_PROJECT_PAGES = 250;
/** The document's maximum for a project's branches. */
const BRANCH_PAGE_SIZE = 10_000;
/** Generous so a server answering with less than `limit` still reaches 10,000 rows. */
export const MAX_CHILD_PAGES = 100;
/** One request per project per type: past this, a poll cannot read them all. */
const MAX_FAN_OUT_PROJECTS = 1_000;

/** A project/branch pair: the scope every beta service is keyed by. */
export interface BranchRef {
  projectId: string;
  branchId: string;
}

/**
 * Neon's branch-scoped services (Object Storage, Functions, AI Gateway) are in
 * Private Beta behind a per-org entitlement flag and are limited to a subset of
 * regions. A branch without the entitlement answers 404 rather than an empty
 * list, so callers treat these statuses as "service not available here" and move
 * on instead of failing the whole listing. For a single read; a listing goes through
 * {@link readBranchServices}, which keeps what a 403 left unread.
 */
export function isServiceUnavailable(err: unknown): boolean {
  const status = httpStatus(err);
  return status === 403 || status === 404 || status === 501;
}

/** The status of a failed SDK call, or `undefined` when no response came back. */
export function httpStatus(err: unknown): unknown {
  return readProp(readProp(err, "response"), "status");
}

/** A credential Neon refuses on permission grounds, as opposed to one it rejects outright. */
export function isPermissionRefused(err: unknown): boolean {
  return httpStatus(err) === 403;
}

/**
 * True for a 4xx that is a settled answer. A throttle or a lock (the document says a
 * 423 is safe to retry) says nothing about what is there, and neither does a 5xx or a
 * failure with no response.
 */
export function isSettledRefusal(err: unknown): boolean {
  const status = httpStatus(err);
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 423 &&
    status !== 425 &&
    status !== 429
  );
}

function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404;
}

export function isNotEnabled(err: unknown): boolean {
  const status = httpStatus(err);
  return status === 404 || status === 501;
}

/**
 * Read one property off a value of unknown provenance, without asserting
 * anything about the value's shape. Returns `undefined` for non-objects.
 *
 * The cast is a widening of an already-proven `object`, not an assertion about
 * its contents: every object satisfies `Record<string, unknown>` at runtime.
 */
function readProp(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * A page's rows, refusing a row that lost a field the document requires: dropping it
 * would read that row as deleted.
 */
export function requireValidRows<T>(
  list: readonly T[] | null | undefined,
  isValid: (row: T) => boolean,
  where: ListPlace & { key: string },
): T[] {
  const rows = requireListPage(list, where);
  const bad = rows.find((row) => !isValid(row));
  if (bad !== undefined) throw new ListPageError({ ...where, found: bad });
  return rows;
}

/**
 * Pull a value off a raw SDK payload the SDK mistypes, keeping it only if it passes
 * `isValue`.
 */
export function validatedObject<T>(
  payload: unknown,
  key: string,
  isValue: (value: unknown) => value is T,
): T | undefined {
  const value = readProp(payload, key);
  return isValue(value) ? value : undefined;
}

/** True when every listed key is present on `value` as a string. */
export function hasStringFields(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  return keys.every((key) => typeof readProp(value, key) === "string");
}

/** Every project the key can see. A project past the cap or not fetched in time throws. */
export async function listAllProjects(api: Api<unknown>): Promise<ProjectListItem[]> {
  const path = "/projects";
  const results: ProjectListItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const resp = await api.listProjects({
      limit: PROJECT_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const rows = requireListPage(resp.data.projects, { vendor: VENDOR, path, key: "projects" });
    // The document: past an implicit time limit the list comes back incomplete, naming
    // the projects it left out here. Those are not gone.
    const unavailable = resp.data.unavailable_project_ids?.length ?? 0;
    if (unavailable > 0) {
      throw new Error(
        `Neon could not read ${unavailable} ${unavailable === 1 ? "project" : "projects"} in time. Try again shortly.`,
      );
    }
    results.push(...rows);
    const next = resp.data.pagination?.cursor;
    // Neon hands out a cursor on the last page too, so an empty page is what ends the list.
    if (!next || rows.length === 0) return results;
    cursor = next;
  }
  throw new ListTruncatedError({
    vendor: VENDOR,
    path,
    items: results.length,
    maxPages: MAX_PROJECT_PAGES,
  });
}

/** Every project, for a list that makes at least one request per project. */
export async function listProjectsToFanOut(api: Api<unknown>): Promise<ProjectListItem[]> {
  return withinListCap(await listAllProjects(api), MAX_FAN_OUT_PROJECTS, {
    vendor: VENDOR,
    path: "/projects",
  });
}

/** Every branch of one project. */
export async function listBranchesOfProject(
  api: Api<unknown>,
  projectId: string,
): Promise<Branch[]> {
  const path = `/projects/${projectId}/branches`;
  const results: Branch[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHILD_PAGES; page++) {
    const resp = await api.listProjectBranches({
      projectId,
      limit: BRANCH_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const rows = requireListPage(resp.data.branches, { vendor: VENDOR, path, key: "branches" });
    results.push(...rows);
    const next = resp.data.pagination?.next;
    if (!next || rows.length === 0) return results;
    cursor = next;
  }
  throw new ListTruncatedError({
    vendor: VENDOR,
    path,
    items: results.length,
    maxPages: MAX_CHILD_PAGES,
  });
}

interface ReadChildrenOptions {
  /** Requests in flight at once. */
  limit?: number;
  /** The answers meaning this parent has none of these. Defaults to a 404: it is gone. */
  isNone?: (err: unknown) => boolean;
}

/**
 * Read a child list for each parent. Every other failure rejects, so stored rows stay:
 * a throttle, a 5xx or a key Neon rejects says nothing about what is there.
 *
 * A 403 is a restricted key, which is normal, so it does not fail the type; `unread` names
 * what that parent's refusal left unread, so those rows stay rather than read as deleted.
 */
export async function readChildren<P, R>(
  parents: readonly P[],
  read: (parent: P) => Promise<R[]>,
  unread: (parent: P) => UnreadListPart,
  { limit, isNone = isNotFound }: ReadChildrenOptions = {},
): Promise<R[]> {
  let refused = 0;
  const rows = await flatMapPooled(
    parents,
    async (parent) => {
      try {
        return await read(parent);
      } catch (err) {
        if (isPermissionRefused(err)) {
          refused++;
          reportUnreadListPart(unread(parent));
          return [];
        }
        if (isNone(err)) return [];
        throw err;
      }
    },
    limit,
  );
  if (parents.length > 0 && refused === parents.length) {
    reportUnreadListPart({ idPrefixes: [""] });
  }
  return rows;
}

/** Enumerate every branch across the given projects. */
export async function enumerateBranches(
  api: Api<unknown>,
  accountId: string,
  projects: readonly ProjectListItem[],
  limit = 1,
): Promise<BranchRef[]> {
  return readChildren(
    projects,
    async (p) => {
      const branches = await listBranchesOfProject(api, p.id);
      return branches.map((b) => ({ projectId: p.id, branchId: b.id }));
    },
    (p) => ({ parentResourceIds: [resourceId(accountId, "neon-project", p.id)] }),
    { limit },
  );
}

/**
 * Read a Private Beta service off each branch, one branch at a time: a branch without
 * the entitlement answers 404 or 501, which is none.
 */
export function readBranchServices<R>(
  accountId: string,
  branches: readonly BranchRef[],
  read: (ref: BranchRef) => Promise<R[]>,
): Promise<R[]> {
  return readChildren(
    branches,
    read,
    (ref) => ({
      parentResourceIds: [resourceId(accountId, "neon-branch", `${ref.projectId}/${ref.branchId}`)],
    }),
    { limit: 1, isNone: isNotEnabled },
  );
}

/** `{accountId}:{typeId}:{externalId}`: the plugin-wide resource id convention. */
export function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

/** Parse a `{projectId}/{branchId}` external id, tolerating extra trailing segments. */
export function parseBranchExternalId(externalId: string): BranchRef {
  const [projectId = "", branchId = ""] = externalId.split("/");
  return { projectId, branchId };
}
