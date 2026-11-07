import {
  ListPageError,
  ListTruncatedError,
  requireListPage,
  type ListPlace,
} from "@infrawrench/plugin-base";
import type { Api, Branch, ProjectListItem } from "@neondatabase/api-client";

const VENDOR = "Neon";

/** The document's maximum for `GET /projects`; its default of 10 is far too small. */
const PROJECT_PAGE_SIZE = 400;
/** 100,000 projects, the most a resource sync takes. */
const MAX_PROJECT_PAGES = 250;
/** The document's maximum for a project's branches. */
const BRANCH_PAGE_SIZE = 10_000;
/** Generous so a server answering with less than `limit` still reaches 10,000 rows. */
export const MAX_CHILD_PAGES = 100;

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
 * `ListRun.readBranchServices`, which keeps what a 403 left unread.
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

/** `{accountId}:{typeId}:{externalId}`: the plugin-wide resource id convention. */
export function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

/** Parse a `{projectId}/{branchId}` external id, tolerating extra trailing segments. */
export function parseBranchExternalId(externalId: string): BranchRef {
  const [projectId = "", branchId = ""] = externalId.split("/");
  return { projectId, branchId };
}
